/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    error::Error,
    path::PathBuf,
    rc::Rc,
    str::FromStr,
};

use euclid::Scale;
use keyboard_types::{
    Code, CompositionEvent, CompositionState, Key, KeyState, Location, Modifiers,
};
use servo::{
    EmbedderControl, ImeEvent, InputEvent, KeyboardEvent as ServoKeyboardEvent, MouseButton,
    MouseButtonAction, MouseButtonEvent, MouseMoveEvent, RenderingContext, Servo, ServoBuilder,
    WebView, WebViewBuilder, WheelDelta, WheelEvent, WheelMode, WindowRenderingContext,
};
use tracing::warn;
use url::Url;
use webrender_api::units::DevicePoint;
use winit::{
    application::ApplicationHandler,
    event::{ElementState, Ime, MouseButton as WinitMouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{EventLoop, EventLoopProxy},
    keyboard::{Key as WinitKey, KeyLocation as WinitKeyLocation, ModifiersState, PhysicalKey},
    raw_window_handle::{HasDisplayHandle, HasWindowHandle},
    window::Window,
};

fn main() -> Result<(), Box<dyn Error>> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install the TLS crypto provider");

    let url = match std::env::args().nth(1) {
        Some(url) => Url::parse(&url)?,
        None => {
            Url::from_file_path(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pages/index.html"))
                .map_err(|_| "Could not build a file URL for the local fixture index")?
        }
    };

    let event_loop = EventLoop::with_user_event().build()?;
    let mut app = App::new(&event_loop, url);
    event_loop.run_app(&mut app)?;
    Ok(())
}

struct AppState {
    window: Window,
    servo: Servo,
    rendering_context: Rc<WindowRenderingContext>,
    webviews: RefCell<Vec<WebView>>,
    cursor_position: Cell<DevicePoint>,
    modifiers: Cell<ModifiersState>,
    pressed_keys: RefCell<HashMap<Code, keyboard_types::KeyboardEvent>>,
    ime_composing: Cell<bool>,
}

impl servo::WebViewDelegate for AppState {
    fn notify_new_frame_ready(&self, _: WebView) {
        self.window.request_redraw();
    }

    fn show_embedder_control(&self, _: WebView, control: EmbedderControl) {
        if matches!(control, EmbedderControl::InputMethod(_)) {
            self.window.set_ime_allowed(true);
        }
    }

    fn hide_embedder_control(&self, webview: WebView, _: servo::EmbedderControlId) {
        self.window.set_ime_allowed(false);
        dismiss_composition(&webview, &self.ime_composing);
    }
}

enum App {
    Initial { waker: Waker, url: Url },
    Running(Rc<AppState>),
}

impl App {
    fn new(event_loop: &EventLoop<WakerEvent>, url: Url) -> Self {
        Self::Initial {
            waker: Waker::new(event_loop),
            url,
        }
    }
}

impl ApplicationHandler<WakerEvent> for App {
    fn resumed(&mut self, event_loop: &winit::event_loop::ActiveEventLoop) {
        let Self::Initial { waker, url } = self else {
            return;
        };
        let display_handle = event_loop
            .display_handle()
            .expect("Could not acquire the display handle");
        let window = event_loop
            .create_window(Window::default_attributes().with_title("Unky · Servo spike"))
            .expect("Could not create the Servo window");
        let window_handle = window
            .window_handle()
            .expect("Could not acquire the window handle");
        let rendering_context = Rc::new(
            WindowRenderingContext::new(display_handle, window_handle, window.inner_size())
                .expect("Could not create the Servo rendering context"),
        );
        let _ = rendering_context.make_current();

        let servo = ServoBuilder::default()
            .event_loop_waker(Box::new(waker.clone()))
            .build();
        servo.setup_logging();

        let state = Rc::new(AppState {
            window,
            servo,
            rendering_context,
            webviews: Default::default(),
            cursor_position: Cell::new(DevicePoint::default()),
            modifiers: Cell::new(ModifiersState::default()),
            pressed_keys: Default::default(),
            ime_composing: Cell::new(false),
        });
        let webview = WebViewBuilder::new(&state.servo, state.rendering_context.clone())
            .url(url.clone())
            .hidpi_scale_factor(Scale::new(state.window.scale_factor() as f32))
            .delegate(state.clone())
            .build();
        state.webviews.borrow_mut().push(webview);
        *self = Self::Running(state);
    }

    fn user_event(&mut self, _event_loop: &winit::event_loop::ActiveEventLoop, _event: WakerEvent) {
        if let Self::Running(state) = self {
            state.servo.spin_event_loop();
        }
    }

    fn window_event(
        &mut self,
        event_loop: &winit::event_loop::ActiveEventLoop,
        _window_id: winit::window::WindowId,
        event: WindowEvent,
    ) {
        if let Self::Running(state) = self {
            state.servo.spin_event_loop();
        }

        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::RedrawRequested => {
                if let Self::Running(state) = self {
                    if let Some(webview) = state.webviews.borrow().last() {
                        webview.paint();
                    }
                    state.rendering_context.present();
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                if let Self::Running(state) = self {
                    let (delta_x, delta_y, mode) = match delta {
                        MouseScrollDelta::LineDelta(dx, dy) => {
                            ((dx * 76.0) as f64, (dy * 76.0) as f64, WheelMode::DeltaLine)
                        }
                        MouseScrollDelta::PixelDelta(delta) => {
                            (delta.x, delta.y, WheelMode::DeltaPixel)
                        }
                    };
                    if let Some(webview) = state.webviews.borrow().last() {
                        webview.notify_input_event(InputEvent::Wheel(WheelEvent::new(
                            WheelDelta {
                                x: delta_x,
                                y: delta_y,
                                z: 0.0,
                                mode,
                            },
                            state.cursor_position.get().into(),
                        )));
                    }
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Self::Running(state) = self {
                    let point = DevicePoint::new(position.x as f32, position.y as f32);
                    state.cursor_position.set(point);
                    if let Some(webview) = state.webviews.borrow().last() {
                        webview.notify_input_event(InputEvent::MouseMove(MouseMoveEvent::new(
                            point.into(),
                        )));
                    }
                }
            }
            WindowEvent::MouseInput {
                state: button_state,
                button,
                ..
            } => {
                if let Self::Running(state) = self {
                    let button = match button {
                        WinitMouseButton::Left => Some(MouseButton::Primary),
                        WinitMouseButton::Middle => Some(MouseButton::Auxiliary),
                        WinitMouseButton::Right => Some(MouseButton::Secondary),
                        WinitMouseButton::Back => Some(MouseButton::Back),
                        WinitMouseButton::Forward => Some(MouseButton::Forward),
                        WinitMouseButton::Other(value) => Some(MouseButton::Other(value)),
                    };
                    if let (Some(webview), Some(button)) = (state.webviews.borrow().last(), button)
                    {
                        let action = match button_state {
                            ElementState::Pressed => MouseButtonAction::Down,
                            ElementState::Released => MouseButtonAction::Up,
                        };
                        webview.notify_input_event(InputEvent::MouseButton(MouseButtonEvent::new(
                            action,
                            button,
                            state.cursor_position.get().into(),
                        )));
                    }
                }
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                if let Self::Running(state) = self {
                    state.modifiers.set(modifiers.state());
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if let Self::Running(state) = self {
                    let Some(keyboard_event) = translate_key(
                        &event.logical_key,
                        event.physical_key,
                        event.location,
                        event.state,
                        event.repeat,
                        state.modifiers.get(),
                        state.ime_composing.get(),
                    ) else {
                        return;
                    };
                    if keyboard_event.state == KeyState::Down {
                        state
                            .pressed_keys
                            .borrow_mut()
                            .insert(keyboard_event.code, keyboard_event.clone());
                    } else {
                        state.pressed_keys.borrow_mut().remove(&keyboard_event.code);
                    }
                    if let Some(webview) = state.webviews.borrow().last() {
                        webview.notify_input_event(InputEvent::Keyboard(ServoKeyboardEvent::new(
                            keyboard_event,
                        )));
                    }
                }
            }
            WindowEvent::Ime(ime) => {
                if let Self::Running(state) = self {
                    if let Some(event) = translate_ime_event(&ime, &state.ime_composing) {
                        if let Some(webview) = state.webviews.borrow().last() {
                            webview.notify_input_event(event);
                        }
                    }
                    match ime {
                        Ime::Enabled => state.window.set_ime_allowed(true),
                        Ime::Disabled => {
                            if let Some(webview) = state.webviews.borrow().last() {
                                dismiss_composition(webview, &state.ime_composing);
                            }
                            state.window.set_ime_allowed(false);
                        }
                        Ime::Preedit(_, _) | Ime::Commit(_) => {}
                    }
                }
            }
            WindowEvent::Focused(false) => {
                if let Self::Running(state) = self {
                    release_pressed_keys(state);
                    state.modifiers.set(ModifiersState::default());
                    if let Some(webview) = state.webviews.borrow().last() {
                        dismiss_composition(webview, &state.ime_composing);
                    }
                    state.window.set_ime_allowed(false);
                }
            }
            WindowEvent::Resized(size) => {
                state_if_running(self, |state| {
                    if let Some(webview) = state.webviews.borrow().last() {
                        webview.resize(size);
                    }
                });
            }
            _ => {}
        }
    }
}

fn translate_key(
    logical_key: &WinitKey,
    physical_key: PhysicalKey,
    key_location: WinitKeyLocation,
    key_state: ElementState,
    repeat: bool,
    modifiers: ModifiersState,
    is_composing: bool,
) -> Option<keyboard_types::KeyboardEvent> {
    let key = match logical_key {
        WinitKey::Character(character) => Key::Character(character.to_string()),
        WinitKey::Named(named) => Key::from_str(&format!("{named:?}"))
            .unwrap_or_else(|_| Key::Character("Unidentified".to_string())),
        WinitKey::Dead(_) => {
            Key::from_str("Dead").unwrap_or_else(|_| Key::Character("Dead".to_string()))
        }
        WinitKey::Unidentified(_) => Key::from_str("Unidentified")
            .unwrap_or_else(|_| Key::Character("Unidentified".to_string())),
    };
    let code = match physical_key {
        PhysicalKey::Code(code) => {
            Code::from_str(&format!("{code:?}")).unwrap_or(Code::Unidentified)
        }
        PhysicalKey::Unidentified(_) => Code::Unidentified,
    };
    let location = match key_location {
        WinitKeyLocation::Standard => Location::Standard,
        WinitKeyLocation::Left => Location::Left,
        WinitKeyLocation::Right => Location::Right,
        WinitKeyLocation::Numpad => Location::Numpad,
    };
    Some(keyboard_types::KeyboardEvent {
        state: match key_state {
            ElementState::Pressed => KeyState::Down,
            ElementState::Released => KeyState::Up,
        },
        key,
        code,
        location,
        modifiers: translate_modifiers(modifiers),
        repeat,
        is_composing,
    })
}

fn translate_modifiers(state: ModifiersState) -> Modifiers {
    let mut modifiers = Modifiers::empty();
    if state.shift_key() {
        modifiers.insert(Modifiers::SHIFT);
    }
    if state.control_key() {
        modifiers.insert(Modifiers::CONTROL);
    }
    if state.alt_key() {
        modifiers.insert(Modifiers::ALT);
    }
    if state.super_key() {
        modifiers.insert(Modifiers::META);
    }
    modifiers
}

fn translate_ime_event(ime: &Ime, composing: &Cell<bool>) -> Option<InputEvent> {
    let event = match ime {
        Ime::Enabled | Ime::Disabled => return None,
        Ime::Preedit(text, _) => {
            let state = if composing.replace(true) {
                CompositionState::Update
            } else {
                CompositionState::Start
            };
            CompositionEvent {
                state,
                data: text.clone(),
            }
        }
        Ime::Commit(text) => {
            composing.set(false);
            CompositionEvent {
                state: CompositionState::End,
                data: text.clone(),
            }
        }
    };
    Some(InputEvent::Ime(ImeEvent::Composition(event)))
}

fn dismiss_composition(webview: &WebView, composing: &Cell<bool>) {
    if take_composing_state(composing) {
        webview.notify_input_event(InputEvent::Ime(ImeEvent::Dismissed));
    }
}

fn take_composing_state(composing: &Cell<bool>) -> bool {
    composing.replace(false)
}

fn release_pressed_keys(state: &AppState) {
    let released = release_key_events(&mut state.pressed_keys.borrow_mut());
    if let Some(webview) = state.webviews.borrow().last() {
        for event in released {
            webview.notify_input_event(InputEvent::Keyboard(ServoKeyboardEvent::new(event)));
        }
    }
}

fn release_key_events(
    pressed: &mut HashMap<Code, keyboard_types::KeyboardEvent>,
) -> Vec<keyboard_types::KeyboardEvent> {
    std::mem::take(pressed)
        .into_values()
        .map(|mut event| {
            event.state = KeyState::Up;
            event.modifiers = Modifiers::empty();
            event
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use winit::keyboard::KeyCode;

    #[test]
    fn translates_character_key_and_macos_command_modifier() {
        let translated = translate_key(
            &WinitKey::Character("a".into()),
            PhysicalKey::Code(KeyCode::KeyA),
            WinitKeyLocation::Standard,
            ElementState::Pressed,
            false,
            ModifiersState::SHIFT | ModifiersState::SUPER,
            false,
        )
        .expect("key events should be forwarded");

        assert_eq!(translated.key, Key::Character("a".to_string()));
        assert_eq!(translated.code, Code::KeyA);
        assert_eq!(translated.state, KeyState::Down);
        assert!(translated.modifiers.contains(Modifiers::SHIFT));
        assert!(translated.modifiers.contains(Modifiers::META));
        assert!(!translated.modifiers.contains(Modifiers::CONTROL));
    }

    #[test]
    fn preserves_keyup_repeat_location_and_composition_flags() {
        let translated = translate_key(
            &WinitKey::Named(winit::keyboard::NamedKey::Enter),
            PhysicalKey::Code(KeyCode::NumpadEnter),
            WinitKeyLocation::Numpad,
            ElementState::Released,
            true,
            ModifiersState::CONTROL,
            true,
        )
        .expect("key events should be forwarded");

        assert_eq!(translated.key, Key::from_str("Enter").unwrap());
        assert_eq!(translated.code, Code::NumpadEnter);
        assert_eq!(translated.location, Location::Numpad);
        assert_eq!(translated.state, KeyState::Up);
        assert!(translated.repeat);
        assert!(translated.is_composing);
        assert!(translated.modifiers.contains(Modifiers::CONTROL));
    }

    #[test]
    fn maps_ime_preedit_and_commit_to_a_composition_lifecycle() {
        let composing = Cell::new(false);
        let start = translate_ime_event(&Ime::Preedit("に".into(), Some((3, 3))), &composing)
            .expect("preedit should be forwarded");
        let update = translate_ime_event(&Ime::Preedit("日本".into(), Some((6, 6))), &composing)
            .expect("updated preedit should be forwarded");
        let end = translate_ime_event(&Ime::Commit("日本語".into()), &composing)
            .expect("committed text should end composition");

        assert_composition(start, CompositionState::Start, "に");
        assert_composition(update, CompositionState::Update, "日本");
        assert_composition(end, CompositionState::End, "日本語");
        assert!(!composing.get());
    }

    #[test]
    fn focus_cleanup_releases_all_pressed_keys_and_clears_modifiers() {
        let key = keyboard_types::KeyboardEvent {
            state: KeyState::Down,
            key: Key::Character("a".to_string()),
            code: Code::KeyA,
            modifiers: Modifiers::SHIFT | Modifiers::META,
            ..Default::default()
        };
        let mut pressed = HashMap::from([(Code::KeyA, key)]);

        let released = release_key_events(&mut pressed);

        assert!(pressed.is_empty());
        assert_eq!(released.len(), 1);
        assert_eq!(released[0].state, KeyState::Up);
        assert!(released[0].modifiers.is_empty());
        assert_eq!(released[0].code, Code::KeyA);
    }

    #[test]
    fn dismissing_ime_composition_clears_active_state_once() {
        let composing = Cell::new(true);

        assert!(take_composing_state(&composing));
        assert!(!take_composing_state(&composing));
        assert!(!composing.get());
    }

    fn assert_composition(
        event: InputEvent,
        expected_state: CompositionState,
        expected_data: &str,
    ) {
        let InputEvent::Ime(ImeEvent::Composition(event)) = event else {
            panic!("expected a Servo composition event");
        };
        assert_eq!(event.state, expected_state);
        assert_eq!(event.data, expected_data);
    }
}

fn state_if_running(app: &App, callback: impl FnOnce(&AppState)) {
    if let App::Running(state) = app {
        callback(state);
    }
}

#[derive(Clone)]
struct Waker(EventLoopProxy<WakerEvent>);

#[derive(Debug)]
struct WakerEvent;

impl Waker {
    fn new(event_loop: &EventLoop<WakerEvent>) -> Self {
        Self(event_loop.create_proxy())
    }
}

impl embedder_traits::EventLoopWaker for Waker {
    fn clone_box(&self) -> Box<dyn embedder_traits::EventLoopWaker> {
        Box::new(self.clone())
    }

    fn wake(&self) {
        if let Err(error) = self.0.send_event(WakerEvent) {
            warn!(?error, "Failed to wake the Servo event loop");
        }
    }
}

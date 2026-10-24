# Ten alternative browsers: research and proposed priorities

Research date: October 23, 2026. This is a proposal for product planning, not an approved implementation roadmap.

## Scope and popularity

The comparison covers Firefox, Opera, Brave, DuckDuckGo, Vivaldi, Tor Browser, Arc, Zen, Orion, and Floorp. It combines established alternatives with smaller browsers especially relevant to our macOS product. The five additions are Firefox, DuckDuckGo, Tor Browser, Orion, and Floorp.

This is a ten-browser research shortlist, not a verified worldwide top-ten audience ranking. Chrome, Safari, and Edge are excluded as mainstream reference browsers. Regional browsers such as Yandex and device-associated browsers such as Samsung Browser would matter to a worldwide market-share study; the shortlist instead focuses on desktop alternatives available on macOS and useful product lessons. Orion and Floorp are included for that relevance, not a demonstrated audience rank.

Several projects do not publish comparable current active-user counts. Download counts, community membership, monthly users, and weekly users must not be treated as equivalent. The table is not ordered by popularity; historical figures retain their dates.

| Browser | Public adoption evidence | Qualification |
| --- | --- | --- |
| Opera | 288 million average monthly active users across products/services in Q1 2026 | Company-wide figure includes non-browser services; not desktop browser users alone. [Investor filing](https://investor.opera.com/static-files/7df85f85-38b6-4d05-a90f-83580e7d06da) |
| Brave | 128.3 million monthly active users as of September 30, 2026 | Vendor-reported browser use across platforms. [Transparency report](https://brave.com/transparency/) |
| Vivaldi | Company reports 4 million users | The company page does not make this directly comparable to Brave's dated MAU series. [Company page](https://vivaldi.com/company/) |
| Arc | No comparable current count verified in reviewed primary sources | Included for product influence and relevance. Its site announces shutdown on December 22, 2026. [Arc announcement](https://arc.net/) |
| Zen | No comparable active-user count verified in reviewed primary sources | Included for relevance to the desired browser experience; not claimed to outrank other browsers by audience. [Project](https://zen-browser.app/) |
| Firefox | Mozilla's November 2025 portfolio strategy gives 145 million MAU | Historical vendor figure, not a verified October 2026 count. [Mozilla strategy](https://blog.mozilla.org/wp-content/blogs.dir/278/files/2025/11/Mozilla-Summary-Portfolio-Strategy.pdf) |
| DuckDuckGo | App page advertises 9 million monthly downloads | Downloads are not active users; search-engine usage must also not be counted as browser usage. [Browser app page](https://duckduckgo.com/app) |
| Tor Browser | Tor publishes network usage estimates, not an equivalent browser MAU count | Estimates come from directory/bridge activity, can include non-browser clients, and should not be ranked against browser MAU. [Metrics methodology](https://metrics.torproject.org/reproducible-metrics.html) |
| Orion | No comparable current active-user count verified | Kagi's native WebKit browser is particularly relevant to our Mac architecture. [Product rationale](https://blog.kagi.com/orion) |
| Floorp | No comparable current active-user count verified | Included for its Firefox-based workspace/customization design. [Project](https://floorp.app/en) |

Popularity establishes adoption, not which features caused adoption. The feature priorities below are product judgments based on usefulness, dependencies, and our macOS implementation.

## Why they were created and what they offer

### Arc — organize the internet around the person

The Browser Company's original pitch was that browsers could do more to help people use the internet. It treated the browser as the place people work, rather than just a frame around individual websites. [Original company description](https://thebrowser.company/)

Its defining combination is a vertical sidebar, Spaces for contexts, and Profiles for separate browsing identities. Each Space has its own pinned and temporary tabs; Profiles scope logins, cookies, history, and other settings. This distinction matters: a visual project group does not automatically isolate accounts. [Spaces](https://resources.arc.net/hc/en-us/articles/19228064149143-Spaces-Distinct-Browsing-Areas), [Profiles](https://resources.arc.net/hc/en-us/articles/19227964556183-Profiles-Separate-Work-Personal-Browsing)

Other notable interactions include a command bar for browser actions and navigation, split views, Peek link previews, and Little Arc for quick lookups. These features reduce context switching and temporary-tab clutter. [Command bar](https://start.arc.net/command-bar-actions), [Multitasking features](https://resources.arc.net/hc/en-us/sections/19211965457687-Multitask)

Lesson for us: combine durable places to return to with lightweight ways to inspect links. Arc is a design reference, not a browser to recommend adopting now given the announced sunset.

### Zen — a calmer, customizable browsing environment

Zen describes itself as a community of developers and designers focused on the browsing experience and privacy. Its welcome page explicitly emphasizes focus and productivity. Unlike the other entries, the relevant origin is a community project rather than a conventional company's product launch. [About](https://zen-browser.app/about/), [Welcome](https://zen-browser.app/welcome/)

Its signature features are workspaces, a compact interface, split views, and Glance. Glance previews a website over the current tab so a short detour need not replace the main task. Zen also exposes an interface customization ecosystem through Zen Mods. These ideas overlap with Arc; the distinction is their combination and implementation, not exclusive ownership of each feature. [Glance](https://docs.zen-browser.app/user-manual/glance), [Zen Mods entry point](https://zen-browser.app/)

Lesson for us: provide compact mode and previews without making basic navigation hard to discover. Workspace organization and account separation need explicit labels and behavior. [Workspace documentation](https://docs.zen-browser.app/user-manual/workspaces)

### Brave — make privacy the default

Brave's founding product mission connects privacy with fixing invasive online advertising and the economics of funding publishers. Its proposed alternative includes opt-in privacy-preserving advertising and rewards. [Brave's stated mission](https://brave.com/blog/brave-ads-launch/)

Its core selling point is Shields: built-in ad/tracker blocking, cookie protections, fingerprinting defenses, and per-site controls. Users can disable protection for a broken site directly from the address bar. Forgetful Browsing adds a per-site option to clear storage after closing that site. [Shields](https://brave.com/shields/), [Forgetful Browsing](https://brave.com/privacy-updates/25-forgetful-browsing/)

Lesson for us: usable privacy needs defaults, visibility, and a recovery path for broken pages. Our WKContentRuleList implementation does not imply feature parity with Brave's engine-level defenses.

### Vivaldi — give demanding users control

Vivaldi's anniversary statement describes its original goal as building a browser for its community as an alternative to Big Tech. Its broader proposition is a highly configurable browser with built-in tools. [Anniversary statement](https://vivaldi.com/blog/ten-years-of-making-new-friends-by-building-a-browser-for-you-not-big-tech/), [Company](https://vivaldi.com/company/)

Its distinctive productivity combination is Workspaces plus Tab Stacks plus Tab Tiling: organize projects, group tabs inside projects, and display pages together. Command Chains let a single action run a sequence of browser commands. [Workspaces](https://vivaldi.com/features/workspaces/), [Tab management](https://vivaldi.com/features/tab-management/), [Command Chains](https://vivaldi.com/blog/vivaldi-introduces-accordion-tabs-and-command-chains/)

Lesson for us: start with useful tab organization and keyboard commands, then expose deeper customization as demand appears.

### Opera — integrate useful tools into the browser

Opera began as a Telenor research project in 1994, with the company following in 1995. Its founders described the browser as a tool for the changes the web would bring to everyday life. Its early work emphasized making browsing useful across devices and connections. [Opera's origin account](https://press.opera.com/2009/04/28/1994-the-year-that-started-it-all/)

Its modern proposition bundles browsing with convenience tools. Relevant features include workspaces, split screen, sidebar services and a music player. These reduce the need to move between separate apps or repeatedly switch tabs. [Feature documentation](https://help.opera.com/en/latest/features/)

Lesson for us: a generic secondary web panel could provide much of the convenience of a messaging integration without maintaining individual service integrations.

### Firefox — preserve choice and an open web

Mozilla's 2004 launch announcement explicitly framed Firefox around preserving browser choice and promoting innovation. Firefox grew out of the Mozilla open-source project, which began with the release of Netscape's browser source. Its origin is a community and nonprofit effort, subsequently supported by Mozilla Corporation, rather than a new venture-backed browser startup. [Launch announcement](https://blog.mozilla.org/press/2004/11/mozilla-foundation-releases-the-highly-anticipated-mozilla-firefox-1-0-web-browser/), [Mozilla history](https://www.mozilla.org/en-US/about/history/)

Its important selling points include an independent browser engine, customization through extensions, and privacy tools. Two especially useful patterns are account containers and local translation. Multi-Account Containers separates cookies and logins by context through a Mozilla extension; Mozilla also announced a built-in Containers preview in Firefox 153, so preview availability should not be confused with a universally available default feature. Firefox's supported desktop translations run on the device rather than sending page content to a translation server. [Containers support](https://support.mozilla.org/en-US/kb/containers), [Containers preview](https://blog.mozilla.org/en/firefox/firefox-containers-preview/), [Translations](https://support.mozilla.org/en-US/kb/website-translation)

Lesson for us: prioritize useful privacy boundaries and clear data handling. A Work account and Personal account should be visibly distinguishable, and translation can eventually offer value without requiring a general AI assistant. Supporting Firefox extensions would require its own compatibility implementation in our browser.

### DuckDuckGo — make privacy understandable and convenient

DuckDuckGo's Mac launch described a response to users asking for its mobile app's simple privacy experience on desktop. Its stated purpose was everyday private browsing with protections built in and few complicated settings. The launch also explicitly used the operating system's rendering engine on Mac, making it a close architectural reference for us. [Mac launch](https://www.spreadprivacy.com/introducing-duckduckgo-for-mac/)

Its memorable interaction is the Fire Button: clear browsing data with an obvious action. Fireproof Sites let users retain chosen sites' sign-in data when clearing. Cookie-pop-up protection reduces repeated consent chores, while its broader browser proposition packages private search and tracking protections together. These features sell understandable outcomes rather than a long settings checklist. [Fire controls](https://safe.duckduckgo.com/duckduckgo-help-pages/privacy/fire-tabs), [Current browser description](https://duckduckgo.com/duckduckgo-help-pages/get-duckduckgo/does-duckduckgo-make-a-browser)

Lesson for us: add a scoped clear-data action with a preview of what will be removed and a clear explanation of retained data. Consider cookie-consent handling later, with actual consent preferences rather than merely hiding notices. Clearing local state does not make a user's network activity anonymous.

### Tor Browser — make anonymity tools accessible

Tor's roots are onion-routing research and an open network designed to resist surveillance. Tor Browser made those tools easier for ordinary users and activists to use. Its purpose differs from a general productivity browser: anonymity and access under censorship are central. [Project history](https://www.torproject.org/about/index)

Distinctive features include routing through the Tor network, New Identity, per-site circuit changes, and security levels that deliberately trade some website functionality for reduced exposure to dangerous features. New Identity and New Circuit are separate actions; a circuit change alone does not clear the browsing session. [Managing identities](https://support.torproject.org/tor-browser/features/managing-identities/), [Security levels](https://support.torproject.org/tor-browser/features/security-levels/)

Lesson for us: privacy actions need precise names and consequences. Borrow scoped resets, clear identity indicators, and explicit protection settings. Tor routing, anti-fingerprinting, and isolation form a coordinated system; reproducing only a reset button would not reproduce Tor's anonymity guarantees. Full Tor integration belongs outside the initial implementation scope.

### Orion — a native Mac browser funded by its users

Kagi says it built Orion because modern browsing had drifted away from serving users. Its stated model emphasizes user funding, engineering quality, privacy, and native platform integration. Kagi had begun Orion before launching its search engine. [Orion rationale](https://blog.kagi.com/orion), [Earlier company rationale](https://blog.kagi.com/what-is-next-for-kagi)

Orion combines WebKit with native Mac behavior, built-in blocking, and a policy of no usage telemetry by default. Its unusual engineering investment is a compatibility layer for Chrome and Firefox extensions; the FAQ describes that support as experimental, not universally compatible. It also provides per-site Compatibility mode to help diagnose problems caused by blocking or extensions. [FAQ](https://browser.kagi.com/faq.html), [Privacy policy](https://browser.kagi.com/privacy.html), [Site controls](https://blog.kagi.com/orion-features)

Lesson for us: native menus, focus behavior, battery/resource use, and site compatibility are product features. WebKit does not inherently rule out extensions, but Orion demonstrates a substantial separate engineering investment, not functionality Tauri gives us automatically. Do not make speed or battery claims without measuring our implementation.

### Floorp — give users control over their workflow

Floorp presents itself as an open-source Firefox-based browser whose purpose is customization. Its support documentation identifies cooperation between Floorp Projects and Ablaze. I found a clear current project mission, but not a sufficiently documented original founder statement to claim a more specific founding motivation. [Project mission](https://floorp.app/en), [Project documentation](https://docs.floorp.app/docs/features/)

Its distinctive combination includes multiple tab layouts, workspaces, split views, web panels, mouse gestures, and a command palette with configurable shortcuts. Workspaces can be assigned Firefox containers, connecting visual project organization to login separation. The panel sidebar also includes built-in notes. [Feature documentation](https://docs.floorp.app/docs/features/), [Workspace containers](https://docs.floorp.app/docs/features/workspaces/), [Panel sidebar](https://docs.floorp.app/docs/features/panel-sidebar/)

Lesson for us: make workspaces and commands extensible in our state model, but present a simple default interface. A small collection of deliberate options is a better initial scope than implementing every layout and gesture at once. Optional notes are worth revisiting after core browsing is dependable.

## Patterns across the ten browsers

This table summarizes documented product emphasis, not exclusive features, benchmark results, or proof that a feature caused adoption.

| Browser | Central promise | Most useful design reference for us |
| --- | --- | --- |
| Arc | Organize browsing around contexts | Spaces, persistent tabs, command bar, previews |
| Zen | Focus with a customizable interface | Compact mode, Glance, workspaces |
| Brave | Protection with minimal setup | Default blocking and understandable per-site exceptions |
| Vivaldi | Control for demanding workflows | Tab groups, tiling, command sequences |
| Opera | Useful tools close to the current task | Secondary web panels and integrated controls |
| Firefox | Open web and user choice | Account containers, local translation, customization |
| DuckDuckGo | Privacy made simple | Clear-data controls and retained-login exceptions |
| Tor Browser | Anonymity and censorship resistance | Precise identity/reset language and explicit tradeoffs |
| Orion | Native Mac experience with privacy | Platform behavior, compatibility controls, efficiency |
| Floorp | A browser shaped to the user's workflow | Workspace/container mapping and configurable commands |

The expanded set strengthens three priorities: make privacy controls easy to understand, treat native Mac quality as part of the core product, and design identity separation before deeply coupling accounts to workspaces. It also makes extension/password-manager compatibility an early research decision even if full implementation remains deferred.

## Recommended product direction

A calm macOS browser for people who keep several projects open: reliable sessions, privacy controls, project workspaces, and fast navigation. Borrow interaction patterns where they solve a problem; keep one coherent model for tabs, bookmarks, pins, and workspaces.

Existing foundations include native website views per tab, a vertical resizable sidebar, bookmarks, settings, appearance selection, native editing/menu shortcuts, and website zoom. Normal browsing currently has no active filtering; the existing filtering proof runs through the fixture path. Session and identity features need further work.

## Proposed implementation order

Order considers daily value, recovery from data loss, technical dependencies, implementation effort, and differentiation. Effort is relative engineering scope, not a time estimate.

| Order | Priority | Feature / first useful scope | Inspiration | Effort |
| --- | --- | --- | --- | --- |
| 1 | P0 | Session persistence and recovery: restore tabs, order, selected tab, and URLs after restart; reopen closed tabs with Cmd-Shift-T | Protect work before building more organization | Medium |
| 2 | P0 | Finish daily browsing basics: find in page, downloads with progress/reveal, link opening in new tabs, history, and tab cycling | Baseline expected before switching browsers | Medium–large |
| 3 | P0 | Real ad/tracker blocking in normal browsing: curated list, safe updates, last-known-good compiled rules, global toggle and saved per-site exceptions | Brave | Large |
| 4 | P0 | Site controls: show origin/connection state, manage supported permissions, clear site data, and offer private browsing with separate ephemeral storage; provide an obvious way to retry a broken site with filtering disabled | Brave, DuckDuckGo, Orion; privacy expectations | Large |
| 5 | P0 research | Authentication compatibility: check passkeys, OS autofill/password-manager options, and the limits of extension APIs before promising daily-driver compatibility | Firefox's extension model; Orion's explicit compatibility work | Medium research; implementation may be large |
| 6 | P1 | Tab organization: drag to reorder, pin/unpin, rename pins, mute tabs; preserve state across restarts | Arc, Zen, Vivaldi | Medium |
| 7 | P1 | Command palette: search/switch open tabs, bookmarks and history; run browser actions | Arc, Vivaldi, Floorp | Medium |
| 8 | P1 | Import/export: bookmark HTML first, then optional session/workspace backups | Reduce switching effort and protect organization | Medium |
| 9 | P1 | Workspaces: named project groups, move tabs, switch via shortcuts, save organization; reserve an explicit profile/identity field for later account isolation | Arc, Zen, Vivaldi, Opera, Floorp | Medium–large |
| 10 | P1 | Split view: two existing tabs, resizable divider, clear focused pane and shortcut routing | Arc, Zen, Vivaldi, Opera, Floorp | Large |
| 11 | P1 | Resource management: measure idle CPU and memory; unload inactive pages safely; protect audio, downloads and unsaved work; include native focus, fullscreen and accessibility behavior in acceptance checks | Orion's platform focus; Vivaldi/Floorp tab workflows | Large |
| 12 | P1 | Separate work/personal profiles: genuinely separate cookies and website storage; visibly label identity and map workspaces to profiles | Arc profiles, Firefox/Floorp containers | Large; depends on native storage support |
| 13 | P1 | Clear-data controls: current site, selected time range, or entire profile; preview scope, explain login loss, and offer explicit retained-site exceptions | DuckDuckGo Fire controls, Brave Forgetful Browsing; Tor's precise reset semantics | Medium–large |
| 14 | P2 | Link preview: explicit gesture opens a dismissible preview; promote to tab; Escape returns to original context | Arc Peek, Zen Glance | Large |
| 15 | P2 | Compact mode: hide sidebar on demand with predictable reveal and keyboard access | Zen, Arc, Floorp | Small–medium |
| 16 | P2 | Reader view and page capture: clean article reading, adjustable text, copy clean links, save PDF | Reading and research workflows | Medium–large |
| 17 | P2 | Cookie-consent management: choose privacy-preserving consent on supported sites and expose exceptions; avoid merely concealing a site's consent UI | DuckDuckGo | Large; ongoing site compatibility work |
| 18 | P2 | Translation: investigate on-device engines and supported languages; disclose any remote processing if a remote service is chosen | Firefox local translation | Large |
| 19 | P3 | Generic web panel, with optional local notes after browsing is dependable | Vivaldi, Opera, Floorp | Medium–large |
| 20 | P3 | Advanced customization: shortcut editor, workspace accents, optional command sequences | Vivaldi, Zen, Floorp | Medium–large |
| 21 | P3 | Encrypted sync for bookmarks and workspace metadata | Multi-device convenience; server/key-management dependency | Large |
| 22 | P3 conditional | Extension compatibility implementation, only after the early architecture investigation establishes a worthwhile supported subset | Firefox's ecosystem; Orion's experimental compatibility layer | Very large |
| 23 | P3 | Optional AI: start with explicit selected-text/page summarization and clear data controls | Evaluate as a separate product decision | Large |

P0 makes the prototype dependable for everyday use. P1 establishes its distinctive workflow. P2 improves focus and handling of larger sessions. P3 requires evidence of demand before expanding scope.

Compared with the five-browser proposal, import/export moves earlier; resource management and real account isolation move into P1; an early authentication/extension feasibility investigation is added; and clear-data controls, cookie-consent handling, and translation become explicit features. AI stays late because the new research provides more immediately useful opportunities without making a remote AI service central to browsing.

## Implementation constraints and decisions

- Workspaces group tabs; profiles isolate identity. Implement workspace metadata first without implying account isolation.
- Split view, previews, settings, command overlays, and panels must share a native WebView visibility/focus coordinator. React overlays alone cannot be assumed to cover native child views reliably.
- Chromium and Firefox extension compatibility is not provided by our Tauri/WKWebView architecture. Treat extensions as a separate architecture investigation; do not promise an existing extension catalog.
- Orion is evidence that a WebKit browser can implement a compatibility layer, not evidence that our current app already supports that layer. Record supported APIs and important incompatible extensions before choosing a scope.
- A clear-data action and private browsing are not Tor's New Identity. Local data deletion must not be described as anonymous network routing or removal of server-side records. Full Tor routing and coordinated anti-fingerprinting remain outside the initial product scope.
- On-device translation and consent handling require their own engines/rules and compatibility work. They do not follow automatically from using WKWebView.
- Brave-style fingerprint defenses and complete blocking diagnostics may require capabilities beyond our current content-rule adapter. Report only protection and measurements we can actually provide.
- Store recoverable browser state through a versioned persistence layer before relying on it for workspaces and pins. Current UI localStorage is useful for preferences, but is not yet a complete session/backup design.
- Windows and Linux feasibility stays deferred as already agreed.

Recommended next implementation: session persistence, startup restore, and recently closed tabs. It prevents lost work and supplies the state foundation needed by pins and workspaces. Continue with everyday browser basics and production macOS filtering before layering on advanced organization.

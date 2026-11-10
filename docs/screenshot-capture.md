# Full-page screenshots

On macOS, choose **Tabs → Save Full Page Screenshot…** to save the active website tab as a PNG. A save dialog lets you choose the destination. After saving, the image also appears as a completed item in that browser window's Downloads list.

Capture uses the website's native WebKit view. It takes overlapping viewport snapshots at document positions and stitches them into one image, so the website view does not visibly scroll while the capture runs. A progress indicator appears in the browser while snapshots are being collected. The original scroll position is restored when capture finishes.

Sticky and fixed elements are included in the first viewport. They are temporarily hidden for later snapshots to avoid repeating them throughout the stitched image, then restored. The page is limited to 30,000 CSS pixels in height and 100 million output pixels; larger pages cannot be saved as one PNG. This feature is currently macOS-only.

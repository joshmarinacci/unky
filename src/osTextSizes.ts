// WebKit exposes the macOS text styles as font keywords. Measure them and publish the sizes as CSS
// variables so the browser chrome follows the OS; other engines keep the defaults from style.css.
const textStyles: Record<string, string> = {
  '--fs-body': '-apple-system-body',
  '--fs-callout': '-apple-system-callout',
  '--fs-sub': '-apple-system-subheadline',
  '--fs-foot': '-apple-system-footnote',
};

export function applyOsTextSizes(): void {
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  try {
    for (const [variable, keyword] of Object.entries(textStyles)) {
      if (!CSS.supports('font', keyword)) continue;
      probe.style.font = keyword;
      const size = getComputedStyle(probe).fontSize;
      if (!/^\d+(\.\d+)?px$/.test(size)) throw new Error(`Unexpected computed size "${size}" for ${keyword}`);
      document.documentElement.style.setProperty(variable, size);
    }
  } finally {
    probe.remove();
  }
}

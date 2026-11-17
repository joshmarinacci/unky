export function snapshotBelongsToWindow(tabs: ReadonlyArray<{ windowLabel?: string }>, windowLabel: string): boolean {
  return tabs.every((tab) => !tab.windowLabel || tab.windowLabel === windowLabel);
}

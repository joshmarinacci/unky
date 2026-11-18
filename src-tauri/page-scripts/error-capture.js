window.__MY_BROWSER_TEST_ERRORS__ = [];
window.addEventListener('error', (event) => window.__MY_BROWSER_TEST_ERRORS__.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__MY_BROWSER_TEST_ERRORS__.push(String(event.reason)));

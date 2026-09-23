// app-entry.js
//
// The landing page (index.html) links here as plain URL query params
// instead of any JS hand-off, since the two pages are now fully separate
// documents. "Create a free account" links to sign-in.html?mode=create; a
// plain "Sign in" link needs nothing since Sign in is already the form's
// default tab. This just reads that one param and clicks the matching
// tab — the actual tab-switching logic lives in app.js, untouched.
(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'create') {
    const tab = document.getElementById('auth-tab-new');
    if (tab) tab.click();
  }
})();

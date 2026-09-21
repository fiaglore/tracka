// landing.js
//
// The landing page and the sign-in form are just two faces of the same
// "not signed in yet" state — see the body.ft-locked / body.landing rules
// in styles.css. Every button here does the same two things: drop the
// `landing` class (which reveals the auth overlay that was already sitting
// underneath, per those CSS rules) and click the right tab on it. No new
// auth logic — the existing sign-in/create-account handling in app.js
// takes over from there untouched.
document.addEventListener('DOMContentLoaded', function () {
  function showAuth(tab) {
    document.body.classList.remove('landing');
    var tabBtn = document.getElementById(tab === 'create' ? 'auth-tab-new' : 'auth-tab-in');
    if (tabBtn) tabBtn.click();
    var userField = document.getElementById('auth-user');
    if (userField) setTimeout(function () { userField.focus(); }, 50);
  }

  ['landing-signin-nav-btn', 'landing-signin-btn', 'landing-signin-btn-2'].forEach(function (id) {
    var btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', function () { showAuth('signin'); });
  });

  var signUpBtn = document.getElementById('landing-signup-btn');
  if (signUpBtn) signUpBtn.addEventListener('click', function () { showAuth('create'); });
});

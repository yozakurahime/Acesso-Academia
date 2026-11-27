(() => {
  const TARGET_URL = 'https://booking.totalpass.com/br/check-ins';
  const isHomePath = () => /^\/br(\/(home|dashboard)?)?\/?$/i.test(location.pathname);

  let redirected = false;
  let timer = null;

  function tryRedirect() {
    if (redirected || !isHomePath()) return false;
    const hasLoginInput = Boolean(document.querySelector('input[type="password"], input[type="email"]'));
    if (hasLoginInput) return false;

    const checkinsLink = document.querySelector('a[href*="/check-ins"]');
    if (!checkinsLink) return false;

    redirected = true;
    if (timer) clearInterval(timer);
    window.location.replace(TARGET_URL);
    return true;
  }

  if (!tryRedirect()) {
    timer = setInterval(tryRedirect, 800);
    setTimeout(() => {
      if (timer) clearInterval(timer);
    }, 120000);
  }
})();

(() => {
  const button = document.getElementById("connect-wallet");
  if (!button) return;
  let sdk;
  let connectedKey;

  const setState = (label, disabled = false) => {
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute("aria-busy", String(disabled));
  };

  async function initialise() {
    setState("Loading wallet", true);
    const config = await fetch("/api/config").then((response) => response.ok ? response.json() : null).catch(() => null);
    window.ArenaApiBaseUrl = String(config?.apiBaseUrl || "").replace(/\/$/, "");
    window.clickSDKOptions = {
      appName: "Arena",
      appId: config?.csprClickAppId || "csprclick-template",
      contentMode: "iframe",
      providers: ["casper-wallet", "ledger", "metamask-snap"]
    };
    window.clickUIOptions = {
      uiContainer: "cspr-click-ui",
      rootAppElement: document.querySelector(".main") ? ".main" : "body",
      defaultTheme: "dark",
      accountMenuItems: [],
    };
    window.addEventListener("csprclick:loaded", () => {
      sdk = window.csprclick;
      setState("Connect Wallet");
      button.addEventListener("click", () => sdk?.signIn());
      sdk?.on("csprclick:signed_in", () => {
        const account = sdk?.getActiveAccount?.();
        connectedKey = account?.public_key?.toLowerCase();
        if (!connectedKey) return;
        setState(`${connectedKey.slice(0, 6)}...${connectedKey.slice(-4)}`);
        const onDashboard = window.location.pathname === "/dashboard" || window.location.pathname.endsWith("dashboard.html");
        if (!onDashboard) {
          setState("Connected - opening dashboard", true);
          window.setTimeout(() => window.location.assign("/dashboard?wallet=connected"), 350);
        }
      });
      sdk?.on("csprclick:switched_account", () => {
        connectedKey = sdk?.getActiveAccount?.()?.public_key?.toLowerCase();
        if (connectedKey) setState(`${connectedKey.slice(0, 6)}...${connectedKey.slice(-4)}`);
      });
      sdk?.on("csprclick:signed_out", () => setState("Connect Wallet"));
      sdk?.on("csprclick:disconnected", () => setState("Connect Wallet"));
    }, { once: true });
    const script = document.createElement("script");
    script.src = "https://cdn.cspr.click/ui/v2.1.0/csprclick-client-2.1.0.js";
    script.id = "csprclick-client";
    script.async = true;
    script.onerror = () => setState("Wallet unavailable");
    document.head.appendChild(script);
  }

  window.ArenaWallet = { getAccount: () => connectedKey, sdk: () => sdk };
  initialise();
})();

// Client-side app.js for ai-admin dashboard
(function () {
  "use strict";

  // Check ai-dev container status on page load
  const banner = document.getElementById("global-banner");
  if (banner) {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.container_status !== "running") {
          banner.innerHTML =
            '<div class="card" style="border-color:var(--danger);margin-bottom:16px;">' +
            '<strong class="text-danger">⚠ ai-dev container is not running</strong>' +
            '<p class="text-sm text-muted mt-4">Some features (auth, SSH, git, projects, upgrade) are unavailable while ai-dev is down.</p>' +
            "</div>";
        }
      })
      .catch(() => {});
  }

  // Toast notification helper
  window.showToast = function (message, type) {
    const container = document.getElementById("toasts");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = "toast" + (type ? " " + type : "");
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  };

  // Handle login form
  const loginForm = document.querySelector("form[action='/api/login']");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const formData = new FormData(loginForm);
      const password = formData.get("password");
      const redirect = formData.get("redirect") || "/";

      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        window.location.href = redirect;
      } else {
        const errEl = document.getElementById("error");
        if (errEl) {
          errEl.style.display = "block";
          errEl.textContent = "Invalid password. Please try again.";
        }
      }
    });
  }

  // Logout link handling
  document.querySelectorAll('a[href="/api/logout"]').forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      await fetch("/api/logout", { method: "POST" });
      window.location.href = "/login";
    });
  });

  // Nav toggle — idempotent on repeated script loads (regression guard)
  var navToggle = null;
  var navBackdrop = null;
  var appLayout = null;
  if (!window.__navUiInit) {
    window.__navUiInit = true;
    navToggle = document.getElementById("nav-toggle");
    navBackdrop = document.getElementById("nav-backdrop");
    appLayout = document.querySelector(".app-layout");
    if (navToggle && navBackdrop && appLayout) {
      navToggle.addEventListener("click", function () {
        appLayout.classList.toggle("nav-open");
      });
      navBackdrop.addEventListener("click", function () {
        appLayout.classList.remove("nav-open");
      });
    }
  }
})();

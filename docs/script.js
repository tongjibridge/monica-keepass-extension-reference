/* Monica KeePass static page — minimal progressive enhancement.
   No dependencies. Only handles the mobile navigation toggle and
   closes it on link click / Escape / outside click. */
(function () {
  "use strict";

  var toggle = document.getElementById("menuToggle");
  var menu = document.getElementById("mobileNav");
  if (!toggle || !menu) return;

  function setOpen(open) {
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  toggle.addEventListener("click", function () {
    setOpen(menu.hidden);
  });

  menu.addEventListener("click", function (event) {
    if (event.target.tagName === "A") setOpen(false);
  });

  document.addEventListener("click", function (event) {
    if (menu.hidden) return;
    if (menu.contains(event.target) || toggle.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !menu.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });

  // Reset to closed state if the viewport grows back to desktop width.
  var desktop = window.matchMedia("(min-width: 761px)");
  function onBreakpoint(event) {
    if (event.matches) setOpen(false);
  }
  if (desktop.addEventListener) {
    desktop.addEventListener("change", onBreakpoint);
  } else if (desktop.addListener) {
    desktop.addListener(onBreakpoint);
  }
})();

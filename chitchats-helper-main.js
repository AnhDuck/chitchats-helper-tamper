// ==UserScript==
// @name         Chit Chats - Auto Print (Shipments + Batches) + Hotkey Fallback
// @namespace    https://tampermonkey.net/
// @version      1.4.0
// @description  Auto-clicks Chit Chats "Print Postage" (Shipments) and "Print Label" (Batches). Adds package weight/dimension presets and postage-step scroll shortcut in shipment edit modals, including batch pages. Provides Ctrl+Shift+P manual hotkey fallback if automated print/download flows are blocked.
// @match        https://chitchats.com/clients/305498/shipments*
// @match        https://chitchats.com/clients/305498/batches*
// @match        https://chitchats.com/clients/305498/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
  WHAT THIS DOES (for future edits):

  - Target pages:
      /clients/305498/shipments*
      /clients/305498/batches*

  - Button detection:
      Finds ALL visible print buttons, including a.js-print-many-button rendered
      inside Chit Chats modals. The button type is detected from the button
      itself instead of only the current page URL so a Print Postage modal can
      still be clicked when it opens from a non-shipments URL.
      Then filters to the "right" one based on:
        * Visible in the DOM (not display:none, not hidden)
        * Text match:
            Shipments: contains "print" + "postage"
            Batches:   contains "print" + "label"
        * Href pattern:
            Shipments: contains "/shipments/" and ends with "/print"
            Batches:   contains "/batches/" and ends with "/print"

  - Clicking strategy:
      1) scrollIntoView + focus
      2) dispatch pointer/mouse events (pointerdown/mousedown/mouseup/click)
      3) also calls element.click() as a final nudge

  - Anti-spam:
      sessionStorage cooldown per page type prevents repeated clicking on SPA re-renders.

  - If auto-click is blocked by Chrome/user-activation rules:
      Use Ctrl+Shift+P to trigger print manually (this is a real user gesture).
*/

(function () {
  "use strict";

  // ========= CONFIG =========
  const AUTO_CLICK_ENABLED = true;  // master switch for automatic click
  const CLICK_DELAY_MS = 600;       // wait after button appears before clicking
  const COOLDOWN_MS = 15000;        // prevent repeat clicks during re-render bursts
  const DEBUG = true;               // console logging

  // Shipments-only: require ids selected in data-params
  // (keeps it from trying to print when nothing is selected)
  const SHIPMENTS_REQUIRE_SELECTED_IDS = true;

  // Hotkey fallback (counts as user gesture):
  // Ctrl+Shift+P triggers a click attempt immediately.
  const HOTKEY_ENABLED = true;

  // Shipments-only: editable dimension presets for L/W/H (cm).
  const DIMENSION_PRESETS = [
    { label: "NO DBAR | 15 x 15 x 5 cm", x: 15, y: 15, z: 5 },
    { label: "w/DBAR | 15 x 18.5 x 5 cm", x: 15, y: 18.5, z: 5 }
  ];

  // ========= HELPERS =========
  const log = (...args) => DEBUG && console.log("[CC AutoPrint]", ...args);

  function isShipmentsPage() {
    return location.pathname.startsWith("/clients/305498/shipments");
  }

  function isBatchesPage() {
    return location.pathname.startsWith("/clients/305498/batches");
  }

  function cooldownKey() {
    return isShipmentsPage()
      ? "cc_autoprint_shipments_last_click_ts"
      : "cc_autoprint_batches_last_click_ts";
  }

  function now() {
    return Date.now();
  }

  function recentlyClicked() {
    const last = Number(sessionStorage.getItem(cooldownKey()) || "0");
    return last && (now() - last) < COOLDOWN_MS;
  }

  function markClicked() {
    sessionStorage.setItem(cooldownKey(), String(now()));
  }

  function isVisible(el) {
    if (!el) return false;
    // Fast checks
    if (el.hidden) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    // Layout-based checks
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    // display/visibility checks
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    return true;
  }

  function decodeDataParams(raw) {
    if (!raw) return null;

    // getAttribute usually returns decoded quotes already, but keep this just in case.
    const normalized = raw.includes("&quot;") ? raw.replace(/&quot;/g, '"') : raw;

    try {
      return JSON.parse(normalized);
    } catch (e) {
      log("Could not parse data-params JSON:", raw, e);
      return null;
    }
  }

  function shipmentsHasSelectedIds(btn) {
    const raw = btn.getAttribute("data-params");
    const parsed = decodeDataParams(raw);
    if (!parsed) return false;
    return Array.isArray(parsed.ids) && parsed.ids.length > 0;
  }

  function normalizedButtonText(btn) {
    return (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizedHref(btn) {
    const raw = btn.getAttribute("href") || "";

    try {
      return new URL(raw, location.origin).pathname;
    } catch (e) {
      return raw;
    }
  }

  function hrefLooksLikeShipmentPrint(btn) {
    const href = normalizedHref(btn);
    return href.includes("/shipments/") && href.endsWith("/print");
  }

  function hrefLooksLikeBatchPrint(btn) {
    const href = normalizedHref(btn);
    return href.includes("/batches/") && href.endsWith("/print");
  }

  function textLooksLikeShipmentPrint(btn) {
    const text = normalizedButtonText(btn);
    return text.includes("print") && text.includes("postage");
  }

  function textLooksLikeBatchPrint(btn) {
    const text = normalizedButtonText(btn);
    return text.includes("print") && text.includes("label");
  }

  function printButtonKind(btn) {
    if (textLooksLikeShipmentPrint(btn) && hrefLooksLikeShipmentPrint(btn)) return "shipments";
    if (textLooksLikeBatchPrint(btn) && hrefLooksLikeBatchPrint(btn)) return "batches";
    return null;
  }

  function isKnownPrintContext() {
    return isShipmentsPage() || isBatchesPage() || Boolean(document.querySelector(".js-print-container"));
  }

  function findBestPrintButton() {
    const all = Array.from(document.querySelectorAll("a.js-print-many-button, .js-print-container a[data-method='patch']"));
    if (!all.length) return null;

    // Filter by the button itself rather than only by the current URL. Chit Chats
    // can render the Print Postage modal while the browser is on another client
    // URL, so URL-only checks reject a valid visible button.
    const candidates = all
      .filter(isVisible)
      .filter((btn) => Boolean(printButtonKind(btn)));

    if (!candidates.length) {
      // Helpful debug: show what exists and which predicate failed.
      log("No matching visible print button found. Found buttons:",
          all.map(a => ({
            text: (a.textContent || "").trim(),
            href: a.getAttribute("href"),
            visible: isVisible(a),
            kind: printButtonKind(a),
            shipmentText: textLooksLikeShipmentPrint(a),
            shipmentHref: hrefLooksLikeShipmentPrint(a),
            batchText: textLooksLikeBatchPrint(a),
            batchHref: hrefLooksLikeBatchPrint(a)
          }))
      );
      return null;
    }

    // Prefer a modal's primary button when present; otherwise use the first match.
    return candidates.find((btn) => btn.closest(".js-print-container")) || candidates[0];
  }

  function dispatchMouseLikeClick(el) {
    // Some apps bind to pointer/mouse down/up instead of click alone.
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0
    };

    try {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) {
      // PointerEvent might not exist in older contexts; fall back to mouse only.
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    }

    // Extra nudge
    el.click();
  }

  const FEEDBACK_STYLE_ID = "cc-button-feedback-style";

  function injectStyle(id, cssText) {
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = cssText;
    document.head.appendChild(style);
  }

  function applyStyles(el, styles = {}) {
    Object.assign(el.style, styles);
  }

  function dispatchInputChange(input) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelectValue(selector, value) {
    const select = document.querySelector(selector);
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function createButton({ text, styles = {}, onClick, id, title, ariaLabel }) {
    const button = document.createElement("button");
    button.type = "button";
    if (id) button.id = id;
    if (title) button.title = title;
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
    button.textContent = text;
    applyStyles(button, styles);
    applyButtonFeedback(button);
    if (onClick) button.addEventListener("click", onClick);
    return button;
  }

  function ensureButtonFeedbackStyles() {
    injectStyle(FEEDBACK_STYLE_ID, `
      .cc-feedback-button {
        transition: transform 0.08s ease, filter 0.08s ease, box-shadow 0.08s ease;
      }

      .cc-feedback-button:active {
        transform: translateY(1px) scale(0.98);
        filter: brightness(0.9);
        box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.18);
      }
    `);
  }

  function applyButtonFeedback(button) {
    ensureButtonFeedbackStyles();
    button.classList.add("cc-feedback-button");
  }

  // ========= BUSINESS DAYS TO DELIVERY (SHIPMENT DETAIL) =========
  const DELIVERY_TIME_ID = "cc-delivery-time";
  const DELIVERY_COPY_BUTTON_ID = "cc-delivery-time-copy";

  function isShipmentDetailPage() {
    if (!isShipmentsPage()) return false;
    const parts = location.pathname.split("/").filter(Boolean);
    return parts[0] === "clients" && parts[2] === "shipments" && parts.length >= 4;
  }

  function parseDateFromHeaderSpan(span) {
    if (!span) return null;
    const title = span.getAttribute("title") || "";
    const datePart = title.split(" ")[0];
    if (!datePart || datePart.length < 10) return null;
    const date = new Date(`${datePart}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function countBusinessDays(startDate, endDate) {
    const current = new Date(startDate);
    current.setDate(current.getDate() + 1);
    let count = 0;

    while (current <= endDate) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) {
        count += 1;
      }
      current.setDate(current.getDate() + 1);
    }

    return count;
  }

  function formatShortDate(date) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function findShipmentId() {
    const strong = document.querySelector(".clearfix strong");
    return strong ? (strong.textContent || "").trim() : "";
  }

  function findTrackingEvents(root) {
    const elements = Array.from(root.querySelectorAll(".tracking-table__title span"));
    let receivedEl = null;
    let deliveredEl = null;

    elements.forEach((el) => {
      const text = (el.textContent || "").trim();
      if (!receivedEl && text === "Received by Chit Chats") {
        receivedEl = el;
      }
      if (!deliveredEl && text.includes("Delivered")) {
        deliveredEl = el;
      }
    });

    return { receivedEl, deliveredEl };
  }

  function findTrackingContainer() {
    return document.querySelector("table.tracking-table")
      || document.querySelector("table");
  }

  function findNearestDateHeader(eventEl) {
    if (!eventEl) return null;
    let row = eventEl.closest("tr");

    while (row) {
      const headerSpan = row.querySelector("span[title]");
      if (headerSpan) return headerSpan;
      row = row.previousElementSibling;
    }

    return null;
  }

  function injectDeliveryTime() {
    if (!isShipmentDetailPage()) return;
    if (document.getElementById(DELIVERY_TIME_ID)) return;

    const container = findTrackingContainer();
    if (!container) return;
    const { receivedEl, deliveredEl } = findTrackingEvents(container);
    if (!receivedEl || !deliveredEl) return;

    const receivedSpan = findNearestDateHeader(receivedEl);
    const deliveredSpan = findNearestDateHeader(deliveredEl);
    const receivedDate = parseDateFromHeaderSpan(receivedSpan);
    const deliveredDate = parseDateFromHeaderSpan(deliveredSpan);
    if (!receivedDate || !deliveredDate) return;

    const businessDays = countBusinessDays(receivedDate, deliveredDate);
    const summary = document.createElement("div");
    summary.id = DELIVERY_TIME_ID;
    applyStyles(summary, {
      margin: "8px 0 12px",
      display: "flex",
      alignItems: "center",
      gap: "8px"
    });

    const text = document.createElement("span");
    text.textContent = `Delivery time: ${businessDays} business days (Received ${formatShortDate(receivedDate)} → Delivered ${formatShortDate(deliveredDate)})`;

    const boldDays = document.createElement("strong");
    boldDays.textContent = `${businessDays} business days`;
    applyStyles(boldDays, { cursor: "pointer" });
    boldDays.title = "Click to copy number of business days";
    const daysStart = text.textContent.indexOf(`${businessDays} business days`);
    if (daysStart !== -1) {
      const before = document.createTextNode(text.textContent.slice(0, daysStart));
      const after = document.createTextNode(text.textContent.slice(daysStart + boldDays.textContent.length));
      text.textContent = "";
      text.append(before, boldDays, after);
    }

    boldDays.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(businessDays));
        const originalText = boldDays.textContent;
        boldDays.textContent = "Copied";
        setTimeout(() => {
          boldDays.textContent = originalText;
        }, 2000);
      } catch (e) {
        log("Copy failed", e);
      }
    });

    const shipmentId = findShipmentId();
    if (!shipmentId) return;

    const button = createButton({
      id: DELIVERY_COPY_BUTTON_ID,
      text: "Copy shipment ID",
      styles: {
        padding: "4px 8px",
        borderRadius: "4px",
        border: "1px solid #ccc",
        background: "#fff",
        cursor: "pointer"
      },
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(shipmentId);
          button.textContent = "Copied";
          setTimeout(() => {
            button.textContent = "Copy shipment ID";
          }, 2000);
        } catch (e) {
          log("Copy failed", e);
        }
      }
    });

    summary.append(text, button);

    const table = container.tagName === "TABLE" ? container : container.querySelector("table");
    if (table) {
      table.insertAdjacentElement("beforebegin", summary);
    } else {
      container.insertAdjacentElement("afterbegin", summary);
    }
  }

  function clickIfReady(reason = "auto") {
    if (!isKnownPrintContext()) return;

    if (reason === "auto" && !AUTO_CLICK_ENABLED) return;

    // Only block repeats for auto mode; hotkey should always try.
    if (reason === "auto" && recentlyClicked()) return;

    const btn = findBestPrintButton();
    if (!btn) return;

    // Avoid clicking if already printing/disabled-ish
    const currentText = (btn.textContent || "").trim().toLowerCase();
    if (currentText.includes("printing")) return;
    if (btn.getAttribute("disabled") !== null) return;

    const kind = printButtonKind(btn);

    // Shipments-only selection guard. Use the matched button type instead of the
    // current URL because Chit Chats can show this modal from several client pages.
    if (kind === "shipments" && SHIPMENTS_REQUIRE_SELECTED_IDS && !shipmentsHasSelectedIds(btn)) {
      log("Shipments: print button found, but ids[] not present/empty. Not clicking.");
      return;
    }

    if (reason === "auto") markClicked();

    // Scroll + focus helps some handlers that require element to be interactable.
    btn.scrollIntoView({ block: "center", inline: "center" });
    btn.focus();

    log(`Clicking (${reason}):`, (btn.textContent || "").trim(), "href=", btn.getAttribute("href"));

    setTimeout(() => {
      dispatchMouseLikeClick(btn);
    }, CLICK_DELAY_MS);
  }

  // ========= WEIGHT/DIMENSION PRESET BUTTONS (SHIPMENT PACKAGE EDIT MODAL) =========
  const WEIGHT_PRESET_VALUES = [113, 226, 340, 450];
  const WEIGHT_PRESET_COLORS = ["#ef8f8b", "#e96d62", "#e4573d", "#d9480f"];
  const WEIGHT_PRESET_CONTAINER_ID = "cc-weight-presets";
  const DIMENSION_PRESET_CONTAINER_ID = "cc-dimension-presets";
  const PRESET_BUTTON_STYLES = {
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    padding: "6px 10px",
    cursor: "pointer"
  };


  function isShipmentPackageEditFormPresent() {
    return Boolean(document.querySelector("#shipment_package_view_model_weight_amount"));
  }

  // Injects preset buttons below the weight row (safe to re-run; no duplicates).
  function setupWeightPresetButtons() {
    if (!isShipmentPackageEditFormPresent()) return;

    const weightInput = document.querySelector("#shipment_package_view_model_weight_amount");
    if (!weightInput) return;
    if (document.getElementById(WEIGHT_PRESET_CONTAINER_ID)) return;

    const weightRow = weightInput.closest(".row");
    if (!weightRow) return;

    const container = document.createElement("div");
    container.id = WEIGHT_PRESET_CONTAINER_ID;
    applyStyles(container, {
      display: "flex",
      gap: "8px",
      marginTop: "0",
      marginBottom: "14px"
    });

    WEIGHT_PRESET_VALUES.forEach((value, index) => {
      const button = createButton({
        text: `${value} g`,
        styles: {
          ...PRESET_BUTTON_STYLES,
          background: WEIGHT_PRESET_COLORS[index] || "#e76f51"
        },
        onClick: () => {
          weightInput.value = String(value);
          setSelectValue("#shipment_package_view_model_weight_unit", "g");
          dispatchInputChange(weightInput);
        }
      });

      container.appendChild(button);
    });

    weightRow.insertAdjacentElement("afterend", container);
  }

  // Injects dimension presets into the form actions (safe to re-run; no duplicates).
  function setupDimensionPresetButtons() {
    if (!isShipmentPackageEditFormPresent()) return;

    const formActions = document.querySelector(".form-actions.text-right");
    if (!formActions) return;
    if (document.getElementById(DIMENSION_PRESET_CONTAINER_ID)) return;

    const lengthInput = document.querySelector("#shipment_package_view_model_size_x_amount");
    const widthInput = document.querySelector("#shipment_package_view_model_size_y_amount");
    const heightInput = document.querySelector("#shipment_package_view_model_size_z_amount");
    if (!lengthInput || !widthInput || !heightInput) return;

    const container = document.createElement("div");
    container.id = DIMENSION_PRESET_CONTAINER_ID;
    applyStyles(container, {
      display: "flex",
      gap: "8px",
      textAlign: "left",
      marginRight: "auto"
    });

    DIMENSION_PRESETS.forEach((preset) => {
      const button = createButton({
        text: preset.label,
        styles: {
          ...PRESET_BUTTON_STYLES,
          background: "#0275d8"
        },
        onClick: () => {
          lengthInput.value = String(preset.x);
          widthInput.value = String(preset.y);
          heightInput.value = String(preset.z);

          setSelectValue("#shipment_package_view_model_size_unit", "cm");
          [lengthInput, widthInput, heightInput].forEach(dispatchInputChange);
        }
      });

      container.appendChild(button);
    });

    formActions.insertAdjacentElement("afterbegin", container);
  }

  // ========= POSTAGE STEP SCROLL SHORTCUT (SHIPMENT POSTAGE EDIT MODAL) =========
  const POSTAGE_SCROLL_BUTTON_ID = "cc-postage-scroll-to-payment";

  function normalizedText(el) {
    return [
      el?.textContent,
      el?.getAttribute?.("value"),
      el?.getAttribute?.("title"),
      el?.getAttribute?.("aria-label")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function findVisibleByText(selector, regex, root = document) {
    return Array.from(root.querySelectorAll(selector))
      .find((el) => isVisible(el) && regex.test(normalizedText(el)));
  }

  function findActivePostageModal() {
    const modalSelectors = [
      "#ajax-modal.modal.show",
      ".modal.show",
      "[role='dialog']",
      ".modal-content"
    ];

    for (const selector of modalSelectors) {
      const modal = Array.from(document.querySelectorAll(selector))
        .find((el) => isVisible(el) && /postage\s+rates/i.test(normalizedText(el)));
      if (modal) return modal;
    }

    const heading = findVisibleByText("h1,h2,h3,h4,strong,legend,label", /postage\s+rates/i);
    return heading?.closest("#ajax-modal, .modal, [role='dialog'], .modal-content") || null;
  }

  function findPostageRatesScope() {
    const modal = findActivePostageModal();
    const root = modal || document;

    const explicitContainer = Array.from(root.querySelectorAll(".js-postage-rates-container"))
      .find((container) => isVisible(container) && container.querySelector("input[type='radio'], .js-postage-rate, label"));
    if (explicitContainer) return explicitContainer;

    const heading = findVisibleByText("h1,h2,h3,h4,strong,legend,label", /postage\s+rates/i, root);
    if (!heading) return null;

    let current = heading;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      const parent = current.parentElement;
      if (parent?.querySelector("input[type='radio'][name*='postage'], .js-postage-rate, [data-formatted-postage-amount]")) {
        return parent;
      }
      current = parent;
    }

    return heading.parentElement;
  }

  function findFirstPostageRate(scope) {
    const selectors = [
      ".postage-rate-box-container",
      ".js-postage-rate",
      "[data-formatted-postage-amount]",
      "input[type='radio'][name*='postage_rate']",
      "input[type='radio'][name*='postage']"
    ];

    for (const selector of selectors) {
      const match = Array.from(scope.querySelectorAll(selector)).find(isVisible);
      if (!match) continue;

      if (match.matches("input")) {
        return match.closest(".postage-rate-box-container, .postage-rate-box, .custom-control, label, div");
      }

      return match;
    }

    return null;
  }

  function isHelperPostageScrollButton(el) {
    return el?.id === POSTAGE_SCROLL_BUTTON_ID;
  }

  function findPayForShipmentButton(scope) {
    const root = scope || findActivePostageModal() || document;
    return Array.from(root.querySelectorAll("button,input[type='submit'],a"))
      .find((el) => isVisible(el) && !isHelperPostageScrollButton(el) && /pay\s+for\s+shipment/i.test(normalizedText(el)));
  }

  function isScrollable(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const overflow = `${style.overflowY} ${style.overflow}`;
    return /(auto|scroll|overlay)/.test(overflow) && el.scrollHeight > el.clientHeight + 1;
  }

  function findBestPostageScrollContainer(scope, target) {
    const modal = scope?.closest?.("#ajax-modal, .modal, [role='dialog'], .modal-content") || findActivePostageModal();

    if (isScrollable(modal)) return modal;

    let current = target || scope;
    while (current && current !== document.body) {
      if (isScrollable(current) && (!modal || modal.contains(current) || current.contains(modal))) {
        return current;
      }
      current = current.parentElement;
    }

    const modalScrollable = modal && Array.from(modal.querySelectorAll("*")).find(isScrollable);
    return modalScrollable || document.scrollingElement || document.documentElement;
  }

  function scrollPostageModalToPayment() {
    const modal = findActivePostageModal();
    const scope = findPostageRatesScope();
    const paymentButton = findPayForShipmentButton(modal || scope);
    const scrollContainer = findBestPostageScrollContainer(modal || scope, paymentButton);

    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" });
    scrollContainer.scrollTop = scrollContainer.scrollHeight;

    if (paymentButton) {
      paymentButton.focus({ preventScroll: true });
    }
  }

  const POSTAGE_SCROLL_STYLE_ID = "cc-postage-scroll-style";

  function ensurePostageScrollStyles() {
    injectStyle(POSTAGE_SCROLL_STYLE_ID, `
      .cc-postage-scroll-anchor {
        position: relative;
      }

      #${POSTAGE_SCROLL_BUTTON_ID} {
        align-items: center;
        background: #e53935;
        border: 0;
        border-radius: 999px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
        color: #fff;
        cursor: pointer;
        display: inline-flex;
        font: 700 22px/1 Arial, sans-serif;
        height: 34px;
        justify-content: center;
        padding: 0;
        position: absolute;
        right: -48px;
        top: 50%;
        transform: translateY(-50%);
        width: 34px;
        z-index: 20;
      }

      #${POSTAGE_SCROLL_BUTTON_ID}:hover,
      #${POSTAGE_SCROLL_BUTTON_ID}:focus-visible {
        background: #c62828;
        outline: 2px solid #fff;
        outline-offset: 2px;
      }

      @media (max-width: 880px) {
        #${POSTAGE_SCROLL_BUTTON_ID} {
          right: 10px;
        }
      }
    `);
  }

  function setupPostageScrollButton() {
    const scope = findPostageRatesScope();
    const firstRate = scope && findFirstPostageRate(scope);
    if (!scope || !firstRate) return;

    const existingButton = document.getElementById(POSTAGE_SCROLL_BUTTON_ID);
    if (existingButton && firstRate.contains(existingButton)) return;
    existingButton?.remove();

    ensurePostageScrollStyles();
    firstRate.classList.add("cc-postage-scroll-anchor");

    const button = createButton({
      id: POSTAGE_SCROLL_BUTTON_ID,
      text: "\u2193",
      styles: {},
      title: "Scroll down",
      ariaLabel: "Scroll down to payment area",
      onClick: scrollPostageModalToPayment
    });

    firstRate.appendChild(button);
  }

  function runPageEnhancements() {
    clickIfReady("auto");
    setupWeightPresetButtons();
    setupDimensionPresetButtons();
    setupPostageScrollButton();
  }

  // ========= RUN =========
  // 1) Attempt once on load
  runPageEnhancements();
  injectDeliveryTime();

  // 2) Watch for SPA/AJAX re-rendering
  const observer = new MutationObserver(runPageEnhancements);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 3) Hotkey fallback for user-gesture-required flows
  if (HOTKEY_ENABLED) {
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        clickIfReady("hotkey");
      }
    }, true);

    log("Hotkey enabled: Ctrl+Shift+P to trigger print.");
  }
})();

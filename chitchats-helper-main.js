// ==UserScript==
// @name         Chit Chats - Auto Print (Shipments + Batches) + Hotkey Fallback
// @namespace    https://tampermonkey.net/
// @version      1.3.0
// @description  Auto-clicks Chit Chats "Print Postage" (Shipments) and "Print Label" (Batches). Picks the visible correct .js-print-many-button, avoids repeat clicks, logs actions, and provides Ctrl+Shift+P manual hotkey fallback if the browser blocks automated print/download flows.
// @match        https://chitchats.com/clients/305498/shipments*
// @match        https://chitchats.com/clients/305498/batches*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
  WHAT THIS DOES (for future edits):

  - Target pages:
      /clients/305498/shipments*
      /clients/305498/batches*

  - Button detection:
      Finds ALL: a.js-print-many-button
      Then filters to the "right" one based on:
        * Visible in the DOM (not display:none, not hidden)
        * Text match:
            Shipments: contains "print" + "postage"
            Batches:   contains "print" + "label"
        * Href pattern:
            Shipments: ends with "/shipments/print"
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

  function hrefLooksRight(btn) {
    const href = btn.getAttribute("href") || "";
    if (isShipmentsPage()) return href.endsWith("/shipments/print");
    if (isBatchesPage()) return href.includes("/batches/") && href.endsWith("/print");
    return false;
  }

  function textLooksRight(btn) {
    const text = (btn.textContent || "").trim().toLowerCase();
    if (isShipmentsPage()) return text.includes("print") && text.includes("postage");
    if (isBatchesPage()) return text.includes("print") && text.includes("label");
    return false;
  }

  function findBestPrintButton() {
    const all = Array.from(document.querySelectorAll("a.js-print-many-button"));
    if (!all.length) return null;

    // Filter: visible + correct page text + correct href pattern
    const candidates = all
      .filter(isVisible)
      .filter(textLooksRight)
      .filter(hrefLooksRight);

    if (!candidates.length) {
      // Helpful debug: show what exists
      log("No matching visible print button found. Found buttons:",
          all.map(a => ({
            text: (a.textContent || "").trim(),
            href: a.getAttribute("href"),
            visible: isVisible(a)
          }))
      );
      return null;
    }

    // If multiple, pick the first (usually only one).
    return candidates[0];
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
    summary.style.margin = "8px 0 12px";
    summary.style.display = "flex";
    summary.style.alignItems = "center";
    summary.style.gap = "8px";

    const text = document.createElement("span");
    text.textContent = `Delivery time: ${businessDays} business days (Received ${formatShortDate(receivedDate)} → Delivered ${formatShortDate(deliveredDate)})`;

    const boldDays = document.createElement("strong");
    boldDays.textContent = `${businessDays} business days`;
    const daysStart = text.textContent.indexOf(`${businessDays} business days`);
    if (daysStart !== -1) {
      const before = document.createTextNode(text.textContent.slice(0, daysStart));
      const after = document.createTextNode(text.textContent.slice(daysStart + boldDays.textContent.length));
      text.textContent = "";
      text.append(before, boldDays, after);
    }

    const button = document.createElement("button");
    button.id = DELIVERY_COPY_BUTTON_ID;
    button.type = "button";
    button.textContent = "Copy shipment ID";
    button.style.padding = "4px 8px";
    button.style.borderRadius = "4px";
    button.style.border = "1px solid #ccc";
    button.style.background = "#fff";
    button.style.cursor = "pointer";

    const shipmentId = findShipmentId();
    if (!shipmentId) return;

    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(shipmentId);
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy shipment ID";
        }, 2000);
      } catch (e) {
        log("Copy failed", e);
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
    if (!isShipmentsPage() && !isBatchesPage()) return;

    if (reason === "auto" && !AUTO_CLICK_ENABLED) return;

    // Only block repeats for auto mode; hotkey should always try.
    if (reason === "auto" && recentlyClicked()) return;

    const btn = findBestPrintButton();
    if (!btn) return;

    // Avoid clicking if already printing/disabled-ish
    const currentText = (btn.textContent || "").trim().toLowerCase();
    if (currentText.includes("printing")) return;
    if (btn.getAttribute("disabled") !== null) return;

    // Shipments-only selection guard
    if (isShipmentsPage() && SHIPMENTS_REQUIRE_SELECTED_IDS && !shipmentsHasSelectedIds(btn)) {
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

  // ========= WEIGHT PRESET BUTTONS (SHIPMENTS EDIT) =========
  const WEIGHT_PRESET_VALUES = [113, 226, 340, 450];
  const WEIGHT_PRESET_CONTAINER_ID = "cc-weight-presets";

  // Injects preset buttons below the weight row (safe to re-run; no duplicates).
  function setupWeightPresetButtons() {
    if (!isShipmentsPage()) return;

    const weightInput = document.querySelector("#shipment_package_view_model_weight_amount");
    if (!weightInput) return;
    if (document.getElementById(WEIGHT_PRESET_CONTAINER_ID)) return;

    const weightRow = weightInput.closest(".row");
    if (!weightRow) return;

    const container = document.createElement("div");
    container.id = WEIGHT_PRESET_CONTAINER_ID;
    container.style.display = "flex";
    container.style.gap = "8px";
    container.style.marginTop = "0";
    container.style.marginBottom = "14px";

    WEIGHT_PRESET_VALUES.forEach((value) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${value} g`;
      button.style.background = "#d9534f";
      button.style.color = "#fff";
      button.style.border = "none";
      button.style.borderRadius = "4px";
      button.style.padding = "6px 10px";
      button.style.cursor = "pointer";

      button.addEventListener("click", () => {
        weightInput.value = String(value);
        weightInput.dispatchEvent(new Event("input", { bubbles: true }));
        weightInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      container.appendChild(button);
    });

    weightRow.insertAdjacentElement("afterend", container);
  }

  // Injects dimension presets into the form actions (safe to re-run; no duplicates).
  function setupDimensionPresetButtons() {
    if (!isShipmentsPage()) return;

    const formActions = document.querySelector(".form-actions.text-right");
    if (!formActions) return;
    if (document.getElementById("cc-dimension-presets")) return;

    const lengthInput = document.querySelector("#shipment_package_view_model_size_x_amount");
    const widthInput = document.querySelector("#shipment_package_view_model_size_y_amount");
    const heightInput = document.querySelector("#shipment_package_view_model_size_z_amount");
    if (!lengthInput || !widthInput || !heightInput) return;

    const container = document.createElement("div");
    container.id = "cc-dimension-presets";
    container.style.display = "flex";
    container.style.gap = "8px";
    container.style.textAlign = "left";
    container.style.marginRight = "auto";

    DIMENSION_PRESETS.forEach((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = preset.label;
      button.style.background = "#0275d8";
      button.style.color = "#fff";
      button.style.border = "none";
      button.style.borderRadius = "4px";
      button.style.padding = "6px 10px";
      button.style.cursor = "pointer";

      button.addEventListener("click", () => {
        lengthInput.value = String(preset.x);
        widthInput.value = String(preset.y);
        heightInput.value = String(preset.z);

        [lengthInput, widthInput, heightInput].forEach((input) => {
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });

      container.appendChild(button);
    });

    formActions.insertAdjacentElement("afterbegin", container);
  }

  // ========= RUN =========
  // 1) Attempt once on load
  clickIfReady("auto");
  setupWeightPresetButtons();
  setupDimensionPresetButtons();
  injectDeliveryTime();

  // 2) Watch for SPA/AJAX re-rendering
  const observer = new MutationObserver(() => {
    clickIfReady("auto");
    setupWeightPresetButtons();
    setupDimensionPresetButtons();
  });
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

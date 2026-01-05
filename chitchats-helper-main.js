// ==UserScript==
// @name         Chit Chats - Auto Print (Shipments + Batches) + Hotkey Fallback
// @namespace    https://tampermonkey.net/
// @version      1.3.0
// @description  Auto-clicks Chit Chats "Print Postage" (Shipments) and "Print Label" (Batches). Adds a "Select all U.S. orders" helper on import select. Picks the visible correct .js-print-many-button, avoids repeat clicks, logs actions, and provides Ctrl+Shift+P manual hotkey fallback if the browser blocks automated print/download flows.
// @match        https://chitchats.com/clients/305498/shipments*
// @match        https://chitchats.com/clients/305498/batches*
// @match        https://chitchats.com/clients/305498/import/select*
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

  function isImportSelectPage() {
    return location.pathname.startsWith("/clients/305498/import/select");
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

  // ========= IMPORT SELECT: U.S. ONLY =========
  const SELECT_US_BUTTON_ID = "cc-select-us-orders";

  function normalizeCountryCode(text) {
    return (text || "")
      .replace(/\./g, "")
      .trim()
      .toUpperCase();
  }

  function getCountryColumnIndex(table) {
    if (!table) return -1;
    const headers = Array.from(table.querySelectorAll("thead th"));
    const headerIndex = headers.findIndex((th) => {
      const label = (th.textContent || "").trim().toLowerCase();
      return label === "country";
    });
    if (headerIndex >= 0) return headerIndex;

    return -1;
  }

  function findDeselectAllButton() {
    const buttons = Array.from(document.querySelectorAll("button, a"));
    return buttons.find((button) => {
      const text = (button.textContent || "").trim().toLowerCase();
      return text === "deselect all";
    });
  }

  function uncheckAllShipments() {
    const inputs = document.querySelectorAll(
      "input[type='checkbox'][name='shipment_import_select_view_model[shipment_import_record_ids][]']"
    );
    inputs.forEach((input) => {
      if (input.checked) {
        input.checked = false;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    const selectAllToggle = document.querySelector("#shipment-all");
    if (selectAllToggle && selectAllToggle.checked) {
      selectAllToggle.checked = false;
      selectAllToggle.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  const CHECKBOX_CLICK_DELAY_MS = 250;
  const SELECTION_RETRY_DELAY_MS = 600;
  const SELECTION_MAX_RETRIES = 2;

  function setCheckboxChecked(checkbox, shouldCheck) {
    if (!checkbox || checkbox.checked === shouldCheck) return;
    checkbox.click();

    if (checkbox.checked !== shouldCheck) {
      checkbox.checked = shouldCheck;
      checkbox.dispatchEvent(new Event("input", { bubbles: true }));
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function getCountryCell(row, countryIndex) {
    if (!row) return null;
    const cells = Array.from(row.querySelectorAll("td"));

    if (countryIndex >= 0 && cells[countryIndex]) {
      return cells[countryIndex];
    }

    return cells.find((cell) => {
      const dataTitle = (cell.getAttribute("data-title") || cell.getAttribute("data-th") || "").toLowerCase();
      return dataTitle === "country";
    }) || null;
  }

  function selectCountryRows(countryCode) {
    const rows = Array.from(
      document.querySelectorAll("tr[class*='js-shipment-import-record-']")
    );
    if (!rows.length) return;

    const table = rows[0].closest("table");
    const countryIndex = getCountryColumnIndex(table);

    rows.forEach((row) => {
      const countryCell = getCountryCell(row, countryIndex);
      const code = normalizeCountryCode(countryCell ? countryCell.textContent : "");
      const checkbox = row.querySelector(
        "input[type='checkbox'][name='shipment_import_select_view_model[shipment_import_record_ids][]']"
      );
      if (!checkbox) return;

      if (code === countryCode) {
        setCheckboxChecked(checkbox, true);
      }
    });
  }

  function getCountryCheckboxes(countryCode) {
    const rows = Array.from(
      document.querySelectorAll("tr[class*='js-shipment-import-record-']")
    );
    if (!rows.length) return [];

    const table = rows[0].closest("table");
    const countryIndex = getCountryColumnIndex(table);

    return rows
      .map((row) => {
        const countryCell = getCountryCell(row, countryIndex);
        const code = normalizeCountryCode(countryCell ? countryCell.textContent : "");
        if (code !== countryCode) return null;
        return row.querySelector(
          "input[type='checkbox'][name='shipment_import_select_view_model[shipment_import_record_ids][]']"
        );
      })
      .filter(Boolean);
  }

  function selectCheckboxesSequentially(checkboxes) {
    if (!checkboxes.length) return Promise.resolve();

    return new Promise((resolve) => {
      let index = 0;
      const tick = () => {
        const checkbox = checkboxes[index];
        if (checkbox) {
          setCheckboxChecked(checkbox, true);
        }
        index += 1;
        if (index >= checkboxes.length) {
          resolve();
          return;
        }
        window.setTimeout(tick, CHECKBOX_CLICK_DELAY_MS);
      };
      tick();
    });
  }

  function waitForDeselectAll(callback, timeoutMs = 2000) {
    const start = Date.now();
    const timer = window.setInterval(() => {
      const checked = document.querySelectorAll(
        "input[type='checkbox'][name='shipment_import_select_view_model[shipment_import_record_ids][]']:checked"
      );
      if (checked.length === 0 || Date.now() - start > timeoutMs) {
        window.clearInterval(timer);
        callback();
      }
    }, 50);
  }

  function countChecked(checkboxes) {
    return checkboxes.filter((checkbox) => checkbox.checked).length;
  }

  function ensureCountrySelection(countryCode, attempt = 0) {
    const checkboxes = getCountryCheckboxes(countryCode);
    if (!checkboxes.length) return Promise.resolve();

    return selectCheckboxesSequentially(checkboxes).then(() => {
      return new Promise((resolve) => {
        window.setTimeout(() => {
          const checked = countChecked(checkboxes);
          if (checked < checkboxes.length && attempt < SELECTION_MAX_RETRIES) {
            resolve(ensureCountrySelection(countryCode, attempt + 1));
            return;
          }
          resolve();
        }, SELECTION_RETRY_DELAY_MS);
      });
    });
  }

  function handleSelectUsOrders(button) {
    if (!isImportSelectPage()) return;

    if (button && button.dataset.busy === "true") return;
    if (button) {
      button.dataset.busy = "true";
      button.disabled = true;
      button.textContent = "Selecting U.S. orders...";
    }

    const deselectButton = findDeselectAllButton();
    if (deselectButton) {
      deselectButton.click();
    } else {
      uncheckAllShipments();
    }

    waitForDeselectAll(() => {
      ensureCountrySelection("US").finally(() => {
        window.setTimeout(() => {
          if (!button) return;
          button.dataset.busy = "false";
          button.disabled = false;
          button.textContent = "Select all U.S. orders";
        }, 300);
      });
    });
  }

  function setupSelectUsButton() {
    if (!isImportSelectPage()) return;
    if (document.getElementById(SELECT_US_BUTTON_ID)) return;

    const summaryText = Array.from(document.querySelectorAll("p.lead"))
      .find((node) => (node.textContent || "").toLowerCase().includes("orders available"));
    const container = summaryText ? summaryText.closest(".d-flex.align-items-center") : null;
    if (!container) return;

    const button = document.createElement("button");
    button.type = "button";
    button.id = SELECT_US_BUTTON_ID;
    button.textContent = "Select all U.S. orders";
    button.style.background = "#0275d8";
    button.style.color = "#fff";
    button.style.border = "none";
    button.style.borderRadius = "4px";
    button.style.padding = "6px 12px";
    button.style.marginLeft = "12px";
    button.style.cursor = "pointer";

    button.addEventListener("click", () => handleSelectUsOrders(button));

    container.appendChild(button);
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
  setupSelectUsButton();

  // 2) Watch for SPA/AJAX re-rendering
  const observer = new MutationObserver(() => {
    clickIfReady("auto");
    setupWeightPresetButtons();
    setupDimensionPresetButtons();
    setupSelectUsButton();
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

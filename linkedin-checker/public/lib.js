/* Pure helpers, no DOM access, so they can be tested in Node. */
(function (root) {
  "use strict";

  /* Accepts 'linkedin.com/in/x', 'www.linkedin.com/in/x' or a full URL. */
  function normalizeUrl(u) {
    u = u.trim();
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    if (u.startsWith("www.")) return "https://" + u;
    return "https://www." + u;
  }

  function parseUrlList(text) {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normalizeUrl);
  }

  /* Same three input options as the desktop app:
     1) li_at value  2) "name=value; name2=value2"  3) Cookie-Editor JSON export */
  function parseCookies({ liAt = "", raw = "", json = "" }) {
    const all = [];
    const has = (name) => all.some((c) => c.name === name);

    const j = json.trim();
    if (j) {
      let parsed;
      try {
        parsed = JSON.parse(j);
      } catch (e) {
        return { error: "Cookie JSON could not be parsed: " + e.message };
      }
      if (!Array.isArray(parsed)) parsed = [parsed];
      for (const item of parsed) {
        if (item && item.name && item.value != null) {
          all.push({
            name: String(item.name),
            value: String(item.value),
            domain: item.domain || ".linkedin.com",
          });
        }
      }
    }

    const l = liAt.trim();
    if (l && !has("li_at")) all.push({ name: "li_at", value: l, domain: ".linkedin.com" });

    const r = raw.trim();
    if (r) {
      for (const part of r.split(";")) {
        const i = part.indexOf("=");
        if (i === -1) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k && !has(k)) all.push({ name: k, value: v, domain: ".linkedin.com" });
      }
    }
    return { cookies: all };
  }

  function csvField(v) {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(rows) {
    const lines = [["Original URL", "Final URL", "Status", "Note", "Checked At"].join(",")];
    for (const r of rows) {
      lines.push(
        [r.original_url, r.final_url, r.status, r.note, r.checked_at].map(csvField).join(",")
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  const APPS_SCRIPT_TEMPLATE = String.raw`function autoMatchCutPaste() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  // ------- এখানে আপনার URL লিস্ট ---------
  var urlList = [
__URL_LINES__
  ];
  // ----------------------------------------

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  var doneList = [];
  var notFoundList = [];
  var skippedList = [];

  urlList.forEach(function(rawUrl) {
    var cleanUrl = rawUrl.trim().toLowerCase().replace(/\/$/, "");

    // প্রতিবার তাজা ডেটা পড়া হচ্ছে, কারণ আগের ধাপে শীট বদলে যেতে পারে
    var allData = sheet.getRange(1, 1, lastRow, lastCol).getValues();

    var matchedRows = []; // { rowNum, filledCount }

    for (var r = 0; r < allData.length; r++) {
      var rowValues = allData[r];
      var found = false;
      var filledCount = 0;

      for (var c = 0; c < rowValues.length; c++) {
        var cellText = String(rowValues[c]).trim();
        if (cellText !== "") filledCount++;

        var cellClean = cellText.toLowerCase().replace(/\/$/, "");
        if (cellClean !== "" && cellClean.indexOf(cleanUrl) !== -1) {
          found = true;
        }
      }

      if (found) {
        matchedRows.push({ rowNum: r + 1, filledCount: filledCount });
      }
    }

    if (matchedRows.length === 0) {
      notFoundList.push(rawUrl);
      return;
    }

    if (matchedRows.length === 1) {
      skippedList.push(rawUrl + "  (শুধু ১ বার পাওয়া গেছে, তাই কিছু করা হয়নি)");
      return;
    }

    // filledCount অনুযায়ী বড় থেকে ছোট সাজানো
    matchedRows.sort(function(a, b) { return b.filledCount - a.filledCount; });

    var sourceRow = matchedRows[0].rowNum;              // সবচেয়ে বেশি ডেটা ভরা সারি
    var targetRow = matchedRows[matchedRows.length - 1].rowNum; // সবচেয়ে কম ডেটা ভরা (খালি/অসম্পূর্ণ) সারি

    if (sourceRow === targetRow) {
      skippedList.push(rawUrl + "  (source ও target একই সারি বের হয়েছে, স্কিপ করা হলো)");
      return;
    }

    // 1) source row-এর ডেটা target row-এ বসানো
    var sourceData = sheet.getRange(sourceRow, 1, 1, lastCol).getValues();
    sheet.getRange(targetRow, 1, 1, lastCol).setValues(sourceData);

    // 2) source row খালি করে দেওয়া (row থাকবে, শুধু content মুছে যাবে)
    sheet.getRange(sourceRow, 1, 1, lastCol).clearContent();

    doneList.push(rawUrl + "  (row " + sourceRow + " → row " + targetRow + ")");
  });

  Logger.log("Done:\n" + doneList.join("\n"));
  if (skippedList.length > 0) Logger.log("Skipped:\n" + skippedList.join("\n"));
  if (notFoundList.length > 0) Logger.log("Not found:\n" + notFoundList.join("\n"));

  SpreadsheetApp.getUi().alert(
    "কাজ শেষ!\n" +
    "সম্পন্ন হয়েছে: " + doneList.length + " টি\n" +
    "স্কিপ হয়েছে: " + skippedList.length + " টি\n" +
    "পাওয়া যায়নি: " + notFoundList.length + " টি" +
    "\n\n(বিস্তারিত দেখতে View > Logs / Execution log চেক করুন)"
  );
}
`;

  function generateAppsScript(urls) {
    if (!urls.length) return "";
    const lines = urls
      .map((u, i) => "    " + JSON.stringify(u) + (i < urls.length - 1 ? "," : ""))
      .join("\n");
    return APPS_SCRIPT_TEMPLATE.replace("__URL_LINES__", lines);
  }

  const lib = { normalizeUrl, parseUrlList, parseCookies, toCsv, generateAppsScript };
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.LC = lib;
})(typeof window !== "undefined" ? window : globalThis);

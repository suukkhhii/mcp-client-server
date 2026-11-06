import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const inputPath = path.join(root, "docs", "MCPorter-Onboarding-Runbook.md");
const outputPath = path.join(root, "docs", "MCPorter-Onboarding-Runbook.pdf");

if (!fs.existsSync(inputPath)) {
  console.error(`Markdown source not found: ${inputPath}`);
  process.exit(1);
}

const markdown = fs.readFileSync(inputPath, "utf8").replace(/\r/g, "");

const pageW = 595.28;
const pageH = 841.89;
const margin = 54;
const contentW = pageW - margin * 2;

const palette = {
  title: [0.04, 0.24, 0.57],
  h2: [0.08, 0.33, 0.18],
  h3: [0.06, 0.4, 0.42],
  body: [0.12, 0.16, 0.22],
  codeText: [0.1, 0.1, 0.12],
  codeBg: [0.95, 0.96, 0.98],
  rule: [0.78, 0.82, 0.88]
};

const fontMetrics = {
  Helvetica: 0.53,
  "Helvetica-Bold": 0.56,
  Courier: 0.6
};

const pages = [];
let page = newPage();

function newPage() {
  const p = {
    stream: [],
    y: pageH - margin
  };
  pages.push(p);
  return p;
}

function setFillRGB(r, g, b) {
  page.stream.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
}

function setStrokeRGB(r, g, b) {
  page.stream.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
}

function ensureSpace(height) {
  if (page.y - height < margin) {
    page = newPage();
  }
}

function estimateTextWidth(text, font, size) {
  const factor = fontMetrics[font] ?? 0.53;
  return text.length * size * factor;
}

function splitWrapped(text, font, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${current} ${words[i]}`;
    if (estimateTextWidth(candidate, font, size) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function esc(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function drawTextLine(text, x, y, font, size, color) {
  setFillRGB(color[0], color[1], color[2]);
  page.stream.push("BT");
  page.stream.push(`/${font} ${size} Tf`);
  page.stream.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`);
  page.stream.push(`(${esc(text)}) Tj`);
  page.stream.push("ET");
}

function writeParagraph(text, font = "Helvetica", size = 10.5, lineGap = 3, color = palette.body) {
  const clean = text.replace(/`([^`]+)`/g, "$1").trim();
  if (!clean) {
    page.y -= 8;
    return;
  }
  const lines = splitWrapped(clean, font, size, contentW);
  const lineHeight = size + lineGap;
  ensureSpace(lines.length * lineHeight + 6);
  for (const line of lines) {
    drawTextLine(line, margin, page.y, font, size, color);
    page.y -= lineHeight;
  }
  page.y -= 2;
}

function writeHeading(text, level) {
  const style = level === 1
    ? { font: "Helvetica-Bold", size: 17, color: palette.title, gapTop: 14, gapBottom: 8 }
    : level === 2
      ? { font: "Helvetica-Bold", size: 13.5, color: palette.h2, gapTop: 10, gapBottom: 6 }
      : { font: "Helvetica-Bold", size: 12, color: palette.h3, gapTop: 8, gapBottom: 4 };
  page.y -= style.gapTop;
  writeParagraph(text, style.font, style.size, 2, style.color);
  page.y -= style.gapBottom;
}

function drawRule() {
  ensureSpace(10);
  const y = page.y;
  setStrokeRGB(palette.rule[0], palette.rule[1], palette.rule[2]);
  page.stream.push("1 w");
  page.stream.push(`${margin.toFixed(2)} ${y.toFixed(2)} m ${(pageW - margin).toFixed(2)} ${y.toFixed(2)} l S`);
  page.y -= 8;
}

function writeListItem(text, bullet = "•", indent = 14) {
  const size = 10.5;
  const lineHeight = size + 3;
  const maxWidth = contentW - indent - 10;
  const lines = splitWrapped(text.replace(/`([^`]+)`/g, "$1"), "Helvetica", size, maxWidth);
  ensureSpace(lines.length * lineHeight + 4);
  drawTextLine(bullet, margin + indent, page.y, "Helvetica-Bold", size, palette.body);
  drawTextLine(lines[0], margin + indent + 10, page.y, "Helvetica", size, palette.body);
  page.y -= lineHeight;
  for (let i = 1; i < lines.length; i += 1) {
    drawTextLine(lines[i], margin + indent + 10, page.y, "Helvetica", size, palette.body);
    page.y -= lineHeight;
  }
  page.y -= 1;
}

function drawRect(x, y, w, h, rgb) {
  setFillRGB(rgb[0], rgb[1], rgb[2]);
  page.stream.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
}

function drawRectStroke(x, y, w, h, rgb, lineWidth = 0.8) {
  setStrokeRGB(rgb[0], rgb[1], rgb[2]);
  page.stream.push(`${lineWidth.toFixed(2)} w`);
  page.stream.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
}

function isTableSeparatorLine(line) {
  const t = line.trim();
  if (!t.startsWith("|")) {
    return false;
  }
  return /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(t);
}

function splitTableRow(line) {
  const trimmed = line.trim();
  const noEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return noEdges.split("|").map((c) => c.trim().replace(/`([^`]+)`/g, "$1"));
}

function computeColumnWidths(headers, rows) {
  const colCount = headers.length;
  const base = new Array(colCount).fill(0);
  const allRows = [headers, ...rows];
  for (const row of allRows) {
    for (let i = 0; i < colCount; i += 1) {
      const len = (row[i] ?? "").length;
      base[i] = Math.max(base[i], Math.min(len, 60));
    }
  }

  const minWeight = 8;
  const weights = base.map((v) => Math.max(minWeight, v));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / sum) * contentW);
}

function rowHeight(cells, colWidths, font, size, lineGap = 2, padY = 4, padX = 5) {
  const lineHeight = size + lineGap;
  let maxLines = 1;
  for (let i = 0; i < colWidths.length; i += 1) {
    const text = cells[i] ?? "";
    const wrapped = splitWrapped(text, font, size, Math.max(16, colWidths[i] - padX * 2));
    maxLines = Math.max(maxLines, wrapped.length);
  }
  return maxLines * lineHeight + padY * 2;
}

function writeTable(headers, rows) {
  const colWidths = computeColumnWidths(headers, rows);
  const headerBg = [0.9, 0.94, 1.0];
  const grid = [0.75, 0.8, 0.88];
  const bodyBg = [1, 1, 1];
  const padX = 5;
  const padY = 4;
  const lineGap = 2;
  const headerFont = "Helvetica-Bold";
  const bodyFont = "Helvetica";
  const fontSize = 9.7;
  const lineHeight = fontSize + lineGap;

  const drawRow = (cells, isHeader = false) => {
    const h = rowHeight(cells, colWidths, isHeader ? headerFont : bodyFont, fontSize, lineGap, padY, padX);
    ensureSpace(h + 2);

    const top = page.y;
    const bottom = top - h;

    let x = margin;
    for (let i = 0; i < colWidths.length; i += 1) {
      const w = colWidths[i];
      drawRect(x, bottom, w, h, isHeader ? headerBg : bodyBg);
      drawRectStroke(x, bottom, w, h, grid, 0.8);

      const text = cells[i] ?? "";
      const wrapped = splitWrapped(text, isHeader ? headerFont : bodyFont, fontSize, Math.max(16, w - padX * 2));
      let ty = top - padY - fontSize;
      for (const line of wrapped) {
        drawTextLine(line, x + padX, ty, isHeader ? headerFont : bodyFont, fontSize, palette.body);
        ty -= lineHeight;
      }

      x += w;
    }

    page.y -= h;
  };

  drawRow(headers, true);
  for (const row of rows) {
    drawRow(row, false);
  }
  page.y -= 6;
}

function writeCodeBlock(lines) {
  const font = "Courier";
  const size = 9;
  const lineHeight = size + 2;
  const blockLines = lines.length ? lines : [""];
  const blockHeight = blockLines.length * lineHeight + 10;
  ensureSpace(blockHeight + 8);
  const topY = page.y + 4;
  drawRect(margin, topY - blockHeight, contentW, blockHeight, palette.codeBg);
  page.y = topY - 6;
  for (const raw of blockLines) {
    drawTextLine(raw, margin + 6, page.y, font, size, palette.codeText);
    page.y -= lineHeight;
  }
  page.y -= 4;
}

function render(md) {
  const lines = md.split("\n");
  let i = 0;
  let inCode = false;
  let codeLines = [];

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (line.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        writeCodeBlock(codeLines);
        inCode = false;
      }
      i += 1;
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      i += 1;
      continue;
    }

    if (line.startsWith("# ")) {
      writeParagraph(line.slice(2).trim(), "Helvetica-Bold", 24, 3, palette.title);
      drawRule();
      i += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      writeHeading(line.slice(3).trim(), 1);
      i += 1;
      continue;
    }
    if (line.startsWith("### ")) {
      writeHeading(line.slice(4).trim(), 2);
      i += 1;
      continue;
    }

    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headers = splitTableRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      writeTable(headers, rows);
      continue;
    }

    const numMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      writeListItem(numMatch[2], `${numMatch[1]}.`, 0);
      i += 1;
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      writeListItem(bulletMatch[1], "•", 8);
      i += 1;
      continue;
    }

    if (!line.trim()) {
      page.y -= 6;
      i += 1;
      continue;
    }

    writeParagraph(line);
    i += 1;
  }
}

render(markdown);

const objects = [];
objects.push("<< /Type /Catalog /Pages 2 0 R >>");

const pageObjectNumbers = [];
const contentObjectNumbers = [];

for (let i = 0; i < pages.length; i += 1) {
  pageObjectNumbers.push(3 + i * 2);
  contentObjectNumbers.push(4 + i * 2);
}

const fontHelvetica = 3 + pages.length * 2;
const fontHelveticaBold = fontHelvetica + 1;
const fontCourier = fontHelvetica + 2;

const kids = pageObjectNumbers.map((n) => `${n} 0 R`).join(" ");
objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [ ${kids} ] >>`;

for (let i = 0; i < pages.length; i += 1) {
  const pageObj = pageObjectNumbers[i];
  const contentObj = contentObjectNumbers[i];
  const stream = pages[i].stream.join("\n");
  objects[pageObj - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /Font << /Helvetica ${fontHelvetica} 0 R /Helvetica-Bold ${fontHelveticaBold} 0 R /Courier ${fontCourier} 0 R >> >> /Contents ${contentObj} 0 R >>`;
  objects[contentObj - 1] = `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`;
}

objects[fontHelvetica - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
objects[fontHelveticaBold - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
objects[fontCourier - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";

let pdf = "%PDF-1.4\n";
const offsets = [0];
for (let i = 0; i < objects.length; i += 1) {
  offsets.push(Buffer.byteLength(pdf, "utf8"));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}

const xrefStart = Buffer.byteLength(pdf, "utf8");
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += "0000000000 65535 f \n";
for (let i = 1; i < offsets.length; i += 1) {
  pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

fs.writeFileSync(outputPath, pdf, "binary");
console.log(`Generated professional PDF: ${outputPath}`);

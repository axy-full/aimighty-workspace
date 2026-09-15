/** Original synthetic screenplay: valid multi-page PDF, no external fixture or content. */
export function screenplayPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(""),
    tree = add(""),
    font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const ids: number[] = [];
  for (const lines of pages) {
    const stream =
      "BT /F1 11 Tf 14 TL 72 730 Td\n" +
      lines
        .map(
          (line, i) =>
            (i ? "T* " : "") + "(" + line.replace(/[\\()]/g, "\\$&") + ") Tj",
        )
        .join("\n") +
      "\nET";
    const contents = add(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
    ids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Count ${ids.length} /Kids [${ids.map((id) => `${id} 0 R`).join(" ")}] >>`;
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

/** A scan-only PDF with no hidden text layer. Raster images are original test artwork. */
export function scannedScreenplayPdf(
  images: { jpeg: Buffer; width: number; height: number }[],
): Buffer {
  const objects: Buffer[] = [],
    ids: number[] = [];
  const add = (body: string | Buffer) => {
    objects.push(typeof body === "string" ? Buffer.from(body) : body);
    return objects.length;
  };
  const catalog = add(""),
    tree = add("");
  for (const { jpeg, width, height } of images) {
    const image = add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        ),
        jpeg,
        Buffer.from("\nendstream"),
      ]),
    );
    const content = "q 612 0 0 792 0 0 cm /Scan Do Q";
    const stream = add(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
    ids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Scan ${image} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${tree} 0 R >>`);
  objects[tree - 1] = Buffer.from(
    `<< /Type /Pages /Count ${ids.length} /Kids [${ids.map((id) => `${id} 0 R`).join(" ")}] >>`,
  );
  const chunks = [Buffer.from("%PDF-1.7\n")],
    offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets
          .slice(1)
          .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
          .join("") +
        `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}

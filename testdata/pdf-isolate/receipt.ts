// A document every release path renders through the published pdf isolate: the
// same definition is the same bytes under Deno and on a Worker, its creation
// date stated, as pdfkit otherwise dates it by the clock.
export const receipt = {
  info: { title: "Adiantamento #1234", creationDate: "2026-01-01T00:00:00Z" },
  content: [
    { text: "Adiantamento #1234", fontSize: 18, bold: true, margin: [0, 0, 0, 8] },
    { text: "Colaborador: Maria Silva · Centro de custo: Vendas", italics: true, margin: [0, 0, 0, 12] },
    {
      table: {
        headerRows: 1,
        widths: ["*", "auto", "auto"],
        body: [["Item", "Data", "Valor"], ...Array.from({ length: 20 }, (_, i) => [`Despesa ${i + 1}`, `2026-11-${String(i + 1).padStart(2, "0")}`, `R$ ${(i * 37.5).toFixed(2)}`])],
      },
      layout: "lightHorizontalLines",
    },
    { ul: ["Aprovado", { text: "Reembolsado", bold: true, italics: true }] },
    { text: "Total: R$ 7.125,00", alignment: "right", bold: true, margin: [0, 12, 0, 0] },
  ],
  footer: { text: "pdfmake", alignment: "center" },
};

// What a renderer may vary but this pin catches: pdfmake's version, its
// fonts, and anything the bytes take from where they were rendered.
export const RECEIPT_SHA256 = "3886cf224f06e6b5eb2a9b5756eb9885d0d1bc265c2db7677df3ce6b1258e0a8";

// The PDF an answer of the isolate carries, as the blob an effect answers.
export async function pdfOf(answer: Response): Promise<Uint8Array<ArrayBuffer>> {
  if (answer.headers.get("content-type") !== "application/json") throw new Error(`the isolate answered ${answer.headers.get("content-type")}`);
  const { $blob } = await answer.json() as { $blob: { base64: string; type: string } };
  if ($blob.type !== "application/pdf") throw new Error(`the isolate's blob is ${$blob.type}`);
  return Uint8Array.from(atob($blob.base64), (c) => c.charCodeAt(0));
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// What any PDF of the receipt shows, whatever its bytes: a PDF, whole, of one
// page, in pdfmake's Roboto, embedded.
export function shape(bytes: Uint8Array): { header: string; trailer: boolean; pages: number; fonts: string[] } {
  const text = new TextDecoder("latin1").decode(bytes);
  return {
    header: text.slice(0, 8),
    trailer: text.trimEnd().endsWith("%%EOF"),
    pages: text.match(/\/Type \/Page\n/g)?.length ?? 0,
    fonts: [...new Set([...text.matchAll(/\/BaseFont \/[A-Z]{6}\+([\w-]+)/g)].map((m) => m[1]))].sort(),
  };
}

// pronto's published pdf isolate, pronto/pdf (docs/isolate-hatches.md,
// Published isolates): a pdfmake document definition in, as the request's JSON
// body, its PDF out.
// pdfmake renders as it does anywhere, in its own default font, Roboto, whose
// faces its browser build carries as a virtual file system bundled here: a
// Worker reads no file, so a font is code or it is nothing.
import pdfMake from "pdfmake/build/pdfmake.js";
import vfs from "pdfmake/build/vfs_fonts.js";

pdfMake.addVirtualFileSystem(vfs);

export default {
  async fetch(request: Request): Promise<Response> {
    let definition;
    try {
      definition = await request.json();
    } catch (error) {
      return new Response(`the body is no JSON: ${error}`, { status: 400 });
    }
    // JSON carries no Date, and pdfkit dates the document by `info`'s.
    for (const key of ["creationDate", "modDate"]) {
      if (typeof definition?.info?.[key] === "string") definition.info[key] = new Date(definition.info[key]);
    }
    let base64: string;
    try {
      base64 = await pdfMake.createPdf(definition).getBase64();
    } catch (error) {
      // A definition pdfmake refuses is refused again on any retry.
      return new Response(`pdfmake refused the document: ${error}`, { status: 422 });
    }
    // Bytes as an effect's answer carries them, since a sink's caller reads
    // JSON or text: the handler answers this blob as it is, and the airlock
    // stores it in the blob plane.
    return Response.json({ $blob: { base64, type: "application/pdf" } });
  },
};

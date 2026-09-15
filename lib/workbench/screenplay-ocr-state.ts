import { assemblePages, type ScreenplayImport } from "./screenplay";

export function screenplayPage(result: ScreenplayImport, number: number) {
  const page = result.pages[number - 1];
  if (!page || page.page !== number)
    throw new Error("Invalid screenplay page.");
  return result.text.slice(page.start, page.end).replace(/\n\f\n$/, "");
}

export function requestOcr(
  result: ScreenplayImport,
  pages: number[],
): ScreenplayImport {
  if (
    !pages.length ||
    pages.some(
      (page) =>
        !Number.isInteger(page) || page < 1 || page > result.pages.length,
    )
  )
    throw new Error("Choose pages from this PDF.");
  return {
    ...result,
    ocr: {
      engine: "tesseract-7.0.0",
      language: "eng",
      requestedPages: [
        ...new Set([...(result.ocr?.requestedPages || []), ...pages]),
      ].sort((a, b) => a - b),
      pages: result.ocr?.pages || [],
    },
  };
}

export function remainingOcrPages(result: ScreenplayImport) {
  const completed = new Set(result.ocr?.pages.map((page) => page.page));
  return (
    result.ocr?.requestedPages.filter((page) => !completed.has(page)) || []
  );
}

export function ocrReviewComplete(result: ScreenplayImport) {
  return (
    !remainingOcrPages(result).length &&
    (result.ocr?.pages.every((page) => page.reviewed) ?? true)
  );
}

function replacePage(result: ScreenplayImport, number: number, text: string) {
  screenplayPage(result, number);
  return {
    ...result,
    ...assemblePages(
      result.pages.map((page) =>
        page.page === number ? text : screenplayPage(result, page.page),
      ),
    ),
  };
}

export function applyOcrPage(
  result: ScreenplayImport,
  number: number,
  text: string,
  confidence: number,
): ScreenplayImport {
  if (!result.ocr?.requestedPages.includes(number))
    throw new Error("This page was not requested for OCR.");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)
    throw new Error("The OCR engine returned an invalid confidence score.");
  return {
    ...replacePage(result, number, text),
    ocr: {
      ...result.ocr,
      pages: [
        ...result.ocr.pages.filter((page) => page.page !== number),
        { page: number, confidence, reviewed: false, corrected: false },
      ].sort((a, b) => a.page - b.page),
    },
  };
}

export function editOcrPage(
  result: ScreenplayImport,
  number: number,
  text: string,
): ScreenplayImport {
  if (!result.ocr?.pages.some((page) => page.page === number))
    throw new Error("Recognize this page before editing its OCR.");
  return {
    ...replacePage(result, number, text),
    ocr: {
      ...result.ocr,
      pages: result.ocr.pages.map((page) =>
        page.page === number
          ? { ...page, reviewed: false, corrected: true }
          : page,
      ),
    },
  };
}

export function reviewOcrPage(
  result: ScreenplayImport,
  number: number,
  reviewed: boolean,
): ScreenplayImport {
  if (!result.ocr?.pages.some((page) => page.page === number))
    throw new Error("Recognize this page before reviewing it.");
  return {
    ...result,
    ocr: {
      ...result.ocr,
      pages: result.ocr.pages.map((page) =>
        page.page === number ? { ...page, reviewed } : page,
      ),
    },
  };
}

/** Narrow adapter for the pinned Tesseract 7 worker protocol. Owning the native
 * worker lets abort/timeout terminate it even while its engine is loading. */
export const OCR_WORKER_PATH = "/vendor/tesseract-7.0.0/worker.min.js";
const ROOT = "/vendor/tesseract-7.0.0";
const STEP_TIMEOUT = 60_000;
type Packet = {
  workerId: string;
  jobId: string;
  action: string;
  status: string;
  data: unknown;
};

export class ScreenplayOcrWorker {
  private worker: Worker;
  private id = crypto.randomUUID();
  private sequence = 0;
  private closed = false;
  private pending?: {
    jobId: string;
    action: string;
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private abort = () =>
    this.terminate(
      new Error("OCR cancelled. Completed pages remain available for review."),
    );

  constructor(
    private signal: AbortSignal,
    private progress: (fraction: number) => void,
  ) {
    this.worker = new Worker(OCR_WORKER_PATH);
    this.worker.onmessage = (event: MessageEvent<Packet>) => {
      const packet = event.data,
        pending = this.pending;
      if (
        !pending ||
        packet?.workerId !== this.id ||
        packet.jobId !== pending.jobId ||
        packet.action !== pending.action
      )
        return;
      if (packet.status === "progress") {
        const fraction = (packet.data as { progress?: unknown })?.progress;
        if (
          pending.action === "recognize" &&
          typeof fraction === "number" &&
          Number.isFinite(fraction)
        )
          this.progress(Math.max(0, Math.min(1, fraction)));
        return;
      }
      if (packet.status !== "resolve" && packet.status !== "reject") return;
      clearTimeout(pending.timer);
      this.pending = undefined;
      if (packet.status === "resolve") pending.resolve(packet.data);
      else {
        pending.reject(
          new Error(
            "The OCR engine could not process this page. Completed pages are retained; retry or cancel this import.",
          ),
        );
        this.terminate();
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(
        new Error(
          "OCR could not load or stopped unexpectedly. Check the connection and retry.",
        ),
      );
    };
    this.worker.onmessageerror = () =>
      this.terminate(
        new Error(
          "The OCR worker returned an unreadable response. Retry this import.",
        ),
      );
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  private call(action: string, payload: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("OCR cancelled."));
    if (this.pending)
      return Promise.reject(new Error("OCR processes one page at a time."));
    return new Promise((resolve, reject) => {
      const jobId = String(++this.sequence);
      const timer = setTimeout(
        () =>
          this.terminate(
            new Error(
              "OCR exceeded one minute on this step. Completed pages are retained; retry on a faster device or use a clearer scan.",
            ),
          ),
        STEP_TIMEOUT,
      );
      this.pending = { jobId, action, resolve, reject, timer };
      try {
        this.worker.postMessage({ workerId: this.id, jobId, action, payload });
      } catch {
        this.terminate(new Error("Could not send this page to OCR."));
      }
    });
  }

  async initialize() {
    await this.call("load", {
      options: {
        lstmOnly: true,
        corePath: location.origin + ROOT + "/core",
        logging: false,
      },
    });
    await this.call("loadLanguage", {
      langs: "eng",
      options: {
        langPath: location.origin + ROOT + "/eng-1.0.0",
        gzip: true,
        lstmOnly: true,
        cacheMethod: "none",
      },
    });
    await this.call("initialize", { langs: "eng", oem: 1, config: {} });
    await this.call("setParameters", {
      params: {
        tessedit_pageseg_mode: "3",
        preserve_interword_spaces: "1",
        user_defined_dpi: "144",
      },
    });
  }

  async recognize(image: Uint8Array) {
    const data = (await this.call("recognize", {
      image,
      options: { rotateAuto: true },
      output: { text: true },
    })) as { text?: unknown; confidence?: unknown };
    if (
      !data ||
      typeof data.text !== "string" ||
      typeof data.confidence !== "number" ||
      !Number.isFinite(data.confidence) ||
      data.confidence < 0 ||
      data.confidence > 100
    )
      throw new Error(
        "OCR returned an invalid page. Nothing from this page was imported.",
      );
    return { text: data.text, confidence: data.confidence };
  }

  terminate(error = new Error("OCR stopped.")) {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    this.worker.terminate();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
  }
}

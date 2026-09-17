// Narrow interfaces for parsers bundled with the project's pinned Next version.
declare module "next/dist/compiled/node-html-parser" {
  export interface HTMLElement {
    nodeType: number;
    rawTagName?: string;
    childNodes: HTMLElement[];
    rawText: string;
    textContent: string;
    getAttribute(name: string): string | undefined;
    querySelector(selector: string): HTMLElement | null;
    querySelectorAll(selector: string): HTMLElement[];
    remove(): void;
  }
  export function parse(html: string): HTMLElement;
}
declare module "next/dist/compiled/ipaddr.js" {
  interface Address {
    kind(): "ipv4" | "ipv6";
    range(): string;
    match(range: [Address, number]): boolean;
  }
  export function parse(address: string): Address;
  export function parseCIDR(address: string): [Address, number];
}

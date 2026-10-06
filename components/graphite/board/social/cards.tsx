"use client";
import { useShell } from "@/lib/shell/state";
import { sendViralSource } from "../../viral/ViralView";
import type { ViralPage } from "@/lib/shell/viral";
import { SOURCE_SECONDS } from "@/lib/shell/viral";
import { Actions, Btn, Meta, Note, Title, Well } from "../ads/cards/common";
import type { CardProps } from "../cards/types";
import { clock, type EffectsData, type SourceData, type UnavailableData } from "./social-model";

/* The Social board's cards: a source video with Motion transfer and Object swap, the Effects card, and what is not built. */

export function SourceCard({ data }: CardProps<SourceData>) {
  const shell = useShell();
  const open = (page: ViralPage) => sendViralSource(page, data.media, (tab) => shell.openMake(tab));
  return (
    <article className="bd-card ab-card" data-testid="social-source">
      <Well url={data.url} media="video" tag={`SOURCE${data.seconds ? ` · ${clock(data.seconds)}` : ""}`} height={173} />
      <span className="ab-body">
        <Title>{data.name}</Title>
        <Meta>{data.origin === "upload" ? "Upload · original kept" : "Made in Particl"}</Meta>
        {data.fits ? (
          <Actions>
            <Btn primary onClick={() => open("motion")} data-testid="social-source-motion">Motion transfer</Btn>
            <Btn onClick={() => open("swap")} data-testid="social-source-swap">Object swap</Btn>
          </Actions>
        ) : <Note>Motion transfer and Object swap take a source of {SOURCE_SECONDS.min}–{SOURCE_SECONDS.max} s{data.seconds ? `; this one is ${clock(data.seconds)}` : ""}.</Note>}
      </span>
    </article>
  );
}

export function EffectsCard({ data }: CardProps<EffectsData>) {
  const shell = useShell();
  return (
    <article className="bd-card ab-card" data-testid="social-effects">
      <span className="ab-body ab-body--fill">
        <Title>Effects</Title>
        <Meta>Two quick tools, opened in Make. Each is priced there once its inputs are set.</Meta>
        <dl className="ab-rows">
          <div className="ab-row"><dt>Motion transfer</dt><dd><Btn onClick={() => shell.openMake("motion")} data-testid="social-effects-motion">Open in Make</Btn></dd></div>
          <div className="ab-row"><dt>Object swap</dt><dd><Btn onClick={() => shell.openMake("swap")} data-testid="social-effects-swap">Open in Make</Btn></dd></div>
        </dl>
        <Meta>{data.sources ? `${data.sources} ${data.sources === 1 ? "source fits" : "sources fit"}` : `No source of ${SOURCE_SECONDS.min}–${SOURCE_SECONDS.max} s yet`}</Meta>
      </span>
    </article>
  );
}

export function SocialUnavailableCard({ data }: CardProps<UnavailableData>) {
  return (
    <article className="bd-card ab-card ab-card--off" data-testid="social-unavailable">
      <span className="ab-body"><Title>{data.title}</Title><Meta>{data.line}</Meta></span>
    </article>
  );
}

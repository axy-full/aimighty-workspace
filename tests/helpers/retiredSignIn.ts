/**
 * What the public site no longer offers. The owner ruled on 28 September 2026
 * that Particl uses provider APIs and loginless MCP only, so nothing may need a
 * Higgsfield sign-in (CLAUDE.md, ground rule 10). These features went with the
 * sign-in. Each pattern carries the feature's name, so a failure says what came
 * back. What replaced them stays sayable: the API's Genjutsu, Marketing Studio
 * Image and Soul, and Particl's own dubbing, voice change, upscale and cut-out.
 */
export const RETIRED_WITH_SIGN_IN: readonly (readonly [string, RegExp])[] = [
  ["connecting a Higgsfield account",
    /\b(?:connect|link|sign in to|sign into|log in to)\w*\s+(?:(?:a|an|your|the|their|its)\s+)?higgsfield\b|\bhiggsfield(?:\.ai)?[\s-]+(?:account|sign[\s-]?in|log[\s-]?in|login|catalogue|catalog|credits|plan)\b/i],
  ["the connected account", /\bconnected\s+(?:account|catalogue|catalog|credits|models|workflows)\b/i],
  ["Marketing Studio video ads", /\bmarketing studio\s+(?:video|ads?)\b|\bvideo ad composer\b/i],
  ["the DTC ad engine", /\bdtc\b/i],
  ["the ad template library", /\bad\s+(?:templates?|formats)\b|\btemplate\s+(?:catalogue|catalog|library|browser)\b|\bcreate with (?:a )?template\b/i],
  ["Business Setup lists", /\bsetup items\b|\bad styles\b/i],
  ["Soul Location and Soul Cast", /\bsoul\s+(?:location|cast)\b/i],
  ["reference elements", /\breference elements?\b/i],
  ["3D generation on the account", /\b3d\s+(?:workflows?|generation)\b/i],
  ["video background removal, deflicker and lip-sync",
    /\bdeflicker|\blip[\s-]?sync|\bvideo background removal\b|\bremove (?:the )?background (?:from|of) (?:a |the )?(?:video|clip)\b/i],
  ["Shorts", /\bshorts\b/i],
  ["the Virality Predictor", /\bviralit(?:y|ies)\b|\banaly[sz]e (?:a )?video\b|\bvideo analysis\b/i],
  ["explainer styles", /\bexplainer\b/i],
  ["motion presets", /\bmotion presets?\b/i],
  ["more than eight Viral references", /\bup to (?:30|thirty),? ordered\b|\b30 ordered\b/i],
  ["skill packs", /\bskill packs?\b/i],
  ["social cuts", /\bsocial cuts?\b/i],
  ["the website's Cinema Studio versions", /\bcinema(?:tic)? studio\s+[23](?:\.\d+)?\b/i],
  ["Higgsfield-hosted audio", /\bhiggsfield[\s-]hosted\b/i],
];

/** Each retired feature the text names, with the words that named it. */
export function retiredFindings(text: string): string[] {
  return RETIRED_WITH_SIGN_IN.flatMap(([label, pattern]) => {
    const hit = text.match(pattern);
    return hit ? [`${label}: "${hit[0]}"`] : [];
  });
}

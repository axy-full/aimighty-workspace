import { test, expect } from "@playwright/test";
import { IDENTITY_RENDER_NAME, PRODUCT_IMAGE_NAME } from "../../lib/uiNames";
import { MARKETING_IMAGE_MODEL_ID, SOUL_CHARACTER_MODEL_ID, displayModelName, retiredLabel } from "../../lib/models";
import { engineLabel } from "../../lib/workspace/engines";
import { neutralModelText } from "../../lib/vendorNames";

const SOUL = ["So", "ul"].join("");
const HIGGSFIELD = ["Higgs", "field"].join("");

test("the two plain names live in one place and every label reads them", () => {
  expect(displayModelName(MARKETING_IMAGE_MODEL_ID)).toBe(PRODUCT_IMAGE_NAME);
  expect(displayModelName(SOUL_CHARACTER_MODEL_ID)).toBe(IDENTITY_RENDER_NAME);
  expect(engineLabel(MARKETING_IMAGE_MODEL_ID).long).toBe(PRODUCT_IMAGE_NAME);
  expect(engineLabel(SOUL_CHARACTER_MODEL_ID).long).toBe(IDENTITY_RENDER_NAME);
  expect(retiredLabel("marketing_studio_image")?.label).toBe(`${PRODUCT_IMAGE_NAME} (earlier account)`);
  expect(neutralModelText(`${SOUL} Character`)).toBe(IDENTITY_RENDER_NAME);
  expect(`${PRODUCT_IMAGE_NAME} ${IDENTITY_RENDER_NAME}`).not.toMatch(new RegExp(`${SOUL}|${HIGGSFIELD}|Marketing`, "i"));
});

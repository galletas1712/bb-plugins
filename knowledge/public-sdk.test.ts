import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

it("uses only public SDK entrypoints and declared UI dependencies", () => {
  const result = experimental_scanPublicSdkOnly(
    fileURLToPath(new URL(".", import.meta.url)),
    {
      allow: [
        /^react(?:\/.*)?$/,
        /^vitest$/,
        /^@testing-library\//,
        /^@radix-ui\//,
        /^class-variance-authority$/,
        /^clsx$/,
        /^tailwind-merge$/,
      ],
    },
  );
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});

import type { MetadataRoute } from "next";

// PWA manifest — "one link, crews Add to Home Screen" (spec §4 distribution).
// Colors pulled from the real brand tokens in src/app/globals.css:
//   --ink:  #0a2430 (deep water / navy)
//   --teal: #137a8c (open water — primary)
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LakeLife",
    short_name: "LakeLife",
    description:
      "One request, one price, one crew at your door — lake home services for Big Long, Pretty & Big Turkey Lakes.",
    start_url: "/portal",
    scope: "/",
    display: "standalone",
    background_color: "#0a2430",
    theme_color: "#0a2430", // matches viewport themeColor + the deep-navy top bar
    orientation: "portrait",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

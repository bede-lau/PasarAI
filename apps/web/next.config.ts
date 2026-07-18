import type { NextConfig } from "next";

if (
  process.env.NODE_ENV === "production" &&
  process.env.PASARAI_SYNTHETIC_PREVIEW === "1"
) {
  throw new Error(
    "PASARAI_SYNTHETIC_PREVIEW cannot be enabled in a production build."
  );
}

const nextConfig: NextConfig = {
  devIndicators: false,
  reactStrictMode: true
};

export default nextConfig;

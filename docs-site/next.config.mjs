/** @type {import('next').NextConfig} */
const nextConfig = {
  // The docs are pure content: no server actions, route handlers, middleware,
  // or request-time APIs. Prerendering every route to HTML keeps hosting a
  // static-file concern, which is what lets this deploy to Vercel without an
  // adapter and without tying the site to one provider.
  output: "export",
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;

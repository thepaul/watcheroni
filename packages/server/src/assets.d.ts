// Module types for the files wrangler.jsonc's rules bundle (see images.ts).
declare module "*.svg" {
  const text: string;
  export default text;
}
declare module "*.png" {
  const bytes: ArrayBuffer;
  export default bytes;
}
declare module "*.ico" {
  const bytes: ArrayBuffer;
  export default bytes;
}

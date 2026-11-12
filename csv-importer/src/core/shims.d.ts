declare module "talisman/metrics/levenshtein.js" {
  const fn: (a: string, b: string) => number;
  export default fn;
}
declare module "talisman/metrics/jaro-winkler.js" {
  const fn: (a: string, b: string) => number;
  export default fn;
}

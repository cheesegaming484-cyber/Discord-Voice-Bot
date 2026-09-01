declare module "lyrics-finder" {
  const findLyrics: (artist: string, title: string) => Promise<string>;
  export default findLyrics;
}
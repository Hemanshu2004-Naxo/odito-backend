// Test render of ONE font file in a FRESH process (run by brandFontService.rendersWith): the renderer's fallback width is measured BEFORE
// the file is loaded, then the sample is drawn with the file. In a long-running process the fallback would be whatever font was loaded
// last, so the comparison is only reliable here. Prints { fallback, own } as JSON. Arguments: <fontfile> <family> <Regular|Bold>.
import sharp from 'sharp';

const [fontfile, family, weightName] = process.argv.slice(2);
const SAMPLE = 'Your agency is out of room to grow 0123';
const width = async (font, file) => (await sharp({ text: { text: SAMPLE, font, ...(file ? { fontfile: file } : {}), rgba: true, dpi: 72 } }).png().toBuffer({ resolveWithObject: true })).info.width;
try {
  const fallback = await width(`OditoNoSuchFamilyXyz ${weightName} 64`, null);
  const own = await width(`${family} ${weightName} 64`, fontfile);
  process.stdout.write(JSON.stringify({ fallback, own }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error?.message || error).slice(0, 200) }));
}

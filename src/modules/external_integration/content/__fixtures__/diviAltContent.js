/**
 * Representative Divi 4.27.7 page content for the alt-text capability. The Fullwidth Header tag is the REAL one stored on the Sapphire
 * homepage (settings abbreviated); the Image and Blurb shapes are the ones observed on its real pages. No fixture is a guess about a
 * write format: every attribute name used here is one the registry's evidence (observed live, or Divi's own builder source) names.
 */

export const HERO_FILE = '2025/12/Digital-Marketing-Agency-That-Delivers-Real-Results.webp';
export const HERO_URL = `https://sapphiredigitalagency.com/wp-content/uploads/${HERO_FILE}`;
export const LOGO_FILE = '2025/12/sapphire-digital-Agency-1.webp';
export const LOGO_URL = `https://sapphiredigitalagency.com/wp-content/uploads/${LOGO_FILE}`;
export const TEAM_FILE = '2025/12/our-team.webp';
export const TEAM_URL = `https://sapphiredigitalagency.com/wp-content/uploads/${TEAM_FILE}`;
export const BG_FILE = '2025/12/Boost-Your-Online-Presence-with-Digital-Marketing-Services-bg-1.webp';

/** Image B: the Fullwidth Header module. It carries NO alt attribute at all, so Divi renders alt="". */
export const heroHeader = (extra = '') => `[et_pb_fullwidth_header title="<abbr>Scale Your Agency </abbr> Without Hiring or Building an In-House Team" subhead="<strong>Expert-led delivery</strong> so you can stay focused on clients." button_one_text="Get Started Now " button_one_url="#" header_image_url="${HERO_URL}" module_class="main-slider" _builder_version="4.27.7" _module_preset="default" title_text_color="#223F99" background_image="https://sapphiredigitalagency.com/wp-content/uploads/${BG_FILE}" custom_button_one="on"${extra}][/et_pb_fullwidth_header]`;

export const imageModule = (src, alt, extra = '') => `[et_pb_image src="${src}"${alt === null ? '' : ` alt="${alt}"`} title_text="our-team" _builder_version="4.27.7" _module_preset="default"${extra}][/et_pb_image]`;
export const blurbModule = (image, alt) => `[et_pb_blurb title="Discovery &amp; Strategy" image="${image}"${alt === null ? '' : ` alt="${alt}"`} _builder_version="4.27.7"]<p>Body copy</p>[/et_pb_blurb]`;

const wrap = (inner) => `<!-- wp:divi/placeholder -->\n[et_pb_section fb_built="1" _builder_version="4.27.7"][et_pb_row _builder_version="4.27.7"][et_pb_column type="4_4" _builder_version="4.27.7"]${inner}[/et_pb_column][/et_pb_row][/et_pb_section]\n<!-- /wp:divi/placeholder -->`;

/** The homepage: the hero header (image B) plus unrelated modules that must never change. */
export const homepage = () => wrap(`${heroHeader()}[et_pb_text _builder_version="4.27.7"]<p>Plain text [with brackets] and "quotes"</p>[/et_pb_text]${imageModule(TEAM_URL, 'Our delivery team at work')}`);

export const withModules = (...mods) => wrap(mods.join(''));
export const DIVI5 = '<!-- wp:divi/section {"builderVersion":"5.0"} --><!-- wp:divi/row --><!-- wp:divi/image {"src":"x"} /--><!-- /wp:divi/row --><!-- /wp:divi/section -->';

# Fonts used by the Creative Studio design composer

These files are drawn into social-media designs by the server-side composer
(`src/modules/social_meta/service/aiDesign/compose/`). They ship with Odito so a
design looks identical on every machine and no font is fetched at render time.

All families are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org):

| Family      | Files                                                        | Source                                        |
| ----------- | ------------------------------------------------------------ | --------------------------------------------- |
| Poppins     | Poppins-Regular/Medium/SemiBold/Bold/ExtraBold.ttf           | https://github.com/google/fonts/tree/main/ofl/poppins    |
| Montserrat  | Montserrat.var.ttf (variable)                                | https://github.com/google/fonts/tree/main/ofl/montserrat |
| Inter       | Inter.var.ttf (variable)                                     | https://github.com/google/fonts/tree/main/ofl/inter      |
| Manrope     | Manrope.var.ttf (variable)                                   | https://github.com/google/fonts/tree/main/ofl/manrope    |
| Sora        | Sora.var.ttf (variable)                                      | https://github.com/google/fonts/tree/main/ofl/sora       |

A brand's heading / body font is used when it is one of these families; any other name falls
back to Poppins and the design reports it (`brand_font_unavailable`).

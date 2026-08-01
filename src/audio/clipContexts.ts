/**
 * WHERE THE JOKES GO.
 *
 * A hand-curated map from a game moment or street source to the *Ce Ne
 * Enervează* lines that
 * suit it, chosen by what each line actually says rather than by filename. The
 * transcripts come from the second clip batch (see docs/reference/ATTRIBUTION.md);
 * `src/audio/manifest.json` is the full library, this is the editorial pass over it.
 *
 * The point is comedy that lands ON something. "Nu ne lansăm niciunde — pare că
 * ne vom târî și atât" is funny when the Dacia is struggling to pull away, and
 * inert anywhere else. Keep that discipline when extending: a line belongs to a
 * context only if hearing it at that exact moment is funnier than hearing it at
 * random.
 *
 * Rules for playback (enforced by the audio system, not by this table):
 *  - never interrupt a line with another line; queue or drop by priority
 *  - never repeat a line until its context has exhausted the others
 *  - duck the radio and ambience under anything from here
 *  - reaction lines must be short; anything over ~9s is radio filler, not a reaction
 */

export interface VoiceLine {
  /** Path under public/, as served. */
  file: string;
  seconds: number;
  /** The Romanian transcript — also used for the subtitle. */
  line: string;
}

export type VoiceContext =
  | 'carFirstStart' | 'carHardAccel' | 'carFuel'
  | 'collisionMinor' | 'collisionMajor' | 'nearMiss'
  | 'starsUp' | 'starsMax' | 'escaped'
  | 'money' | 'recorder' | 'nicusor' | 'georgescu' | 'broadcastWin'
  | 'radioFiller'
  | 'streetKiosk' | 'streetDoorway' | 'streetParkedCar'
  /** @deprecated Use one of the source-specific street contexts. */
  | 'streetOverheard';

/** Physical source of a free-roam street line. */
export type StreetVoiceSource = 'kiosk' | 'doorway' | 'parkedCar';

/** The editorial pool used for each physical source. */
export const STREET_CONTEXT_BY_SOURCE: Record<StreetVoiceSource, VoiceContext> = {
  kiosk: 'streetKiosk',
  doorway: 'streetDoorway',
  parkedCar: 'streetParkedCar',
};

export const STREET_VOICE_CONTEXTS = [
  'streetKiosk', 'streetDoorway', 'streetParkedCar',
] as const satisfies readonly VoiceContext[];

/**
 * Clips observed in the old shared street bag. They are valid source audio,
 * but are sign-offs with no visible setup, so they must never be unsolicited
 * street ambience. Keep the file-level gate beside the editorial pools so a
 * future copy/paste cannot quietly reintroduce them.
 */
export const STREET_EXCLUDED_FILES: ReadonlySet<string> = new Set([
  'audio/vo/ce-ne-enerveaza-new/episode-52/11-dopamina-informata.mp3',
  'audio/vo/ce-ne-enerveaza-new/episode-50/08-pozitiv-la-dopamina.mp3',
  'audio/vo/ce-ne-enerveaza-new/episode-50/09-trag-dopamina-in-mine.mp3',
]);

export const VOICE_CONTEXTS: Record<VoiceContext, VoiceLine[]> = {
  carFirstStart: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/02-nu-ne-lansam-niciunde.mp3", seconds: 3.6, line: "Nu ne lansăm niciunde. Pare că ne vom târî și atât." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/03-romania-legata-cu-sarme.mp3", seconds: 6.4, line: "Toată România de azi e legată cu sârme, bate, troncăne." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/04-cu-caruta-tragem-barca-pe-uscat.mp3", seconds: 8.8, line: "Noi tot cu căruța, cu boi, tragem barca pe uscat." },
  ],
  carHardAccel: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/01-drone-cu-scame-din-buric.mp3", seconds: 8.75, line: "Încercăm să construim drone cu scame din buric." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/18-winning-too-much.mp3", seconds: 29.45, line: "We're winning too much. We can't take it anymore." },
  ],
  carFuel: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/10-douazeci-de-ron-motor.mp3", seconds: 6.85, line: "Mie de benzinar mi s-a rupt sufletul. Douăzeci de RON motor." },
  ],
  collisionMinor: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/05-bai-tu-esti-prost.mp3", seconds: 14.5, line: "Eu mă gândesc așa ca prostul... Băi, tu ești prost? Cred că da." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/10-taci-din-gura.mp3", seconds: 9.95, line: "O lecție pe care e bine să o primești la timp. Taci din gură." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/07-prost-mai-eram-cand-eram-ministru.mp3", seconds: 4.4, line: "Bă, dar prost mai eram când eram ministru." },
  ],
  collisionMajor: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/04-ma-fac-de-ras.mp3", seconds: 8.1, line: "Bă, mă fac de râs, mă vede lumea. Iar fac toți mișto de mine." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/09-ecografie-ficat.mp3", seconds: 7.75, line: "E ca și cum aplaudăm când vedem pe ecografie că ne-a ieșit ficatul de trei ori mai mare." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/01-drona-si-doi-raniti-usor.mp3", seconds: 11.5, line: "A căzut o dronă în Galați. Nu sunt victime. Doi răniți ușor." },
  ],
  nearMiss: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/13-ciolacu-fix-asta-faceam.mp3", seconds: 7.25, line: "Se uită Ciolacu și zice: Bă, ești nebun? Fix asta făceam și eu." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/02-au-scapat-usor-galatenii.mp3", seconds: 8.55, line: "Față de privatizări sau mandate de primar PSD, au scăpat foarte ușor gălățenii." },
  ],
  starsUp: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/03-puscaria-il-mananca-pe-putin.mp3", seconds: 11.7, line: "S-a deschis dosar penal. Din ce înțeleg, pușcăria îl mănâncă pe Putin." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/03-penalitati-ca-la-chiloti.mp3", seconds: 8.5, line: "Penalități, accesorii, de parcă te cheamă să probezi chiloți." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/06-dobanda-ca-un-sobolan.mp3", seconds: 12.7, line: "Cum să-mi iei dobândă ca un năpârcă, ca un șobolan, apoi să-mi spui să fac contestație?" },
  ],
  starsMax: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/16-sfarsitul-ciudat.mp3", seconds: 10.55, line: "Totul se întâmplă ca acum să fie exact ca în profeție: sfârșitul ciudat." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/17-exista-dumnezeu.mp3", seconds: 15.45, line: "Există Dumnezeu. Cu noi este Dumnezeu." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/07-logica-de-la-aer-conditionat.mp3", seconds: 16.7, line: "Nu un general căruia i s-a micșorat logica de la atâta aer condiționat." },
  ],
  escaped: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/04-putin-la-jilava-in-douazeci-si-cinci-de-ani.mp3", seconds: 15.55, line: "O să vadă în douăzeci și cinci de ani: e la Jilava. Nu știe cu cine s-a pus." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/02-observator-la-ferrari.mp3", seconds: 16.8, line: "S-a dus la Consiliul Păcii cum intru eu la reprezentanța Ferrari: nu doresc ceva, doar mă uit." },
  ],
  money: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/08-mamaliga-si-ceapa.mp3", seconds: 5.35, line: "Tu-ți dai banii, că ți-am dat o sută cincizeci de RON să-ți iei mămăligă și ceapă." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/04-o-sa-o-platesc.mp3", seconds: 8.95, line: "Știți ce o să fac? O s-o plătesc. Te rog frumos, dă-mi banii." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/02-anaf-muncea-de-revelion.mp3", seconds: 8.8, line: "Treizeci și unu decembrie muncea ANAF-ul pentru mine. Chiar m-am simțit important." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/01-anaf-spv-barosane.mp3", seconds: 11.3, line: "Niciuna, Răducule. Mânca-ți-aș SPV-ul tău. Bine, barosane, te salută fratele tău." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/05-unde-pot-contesta.mp3", seconds: 15.65, line: "Trebuie să contestați. Unde pot să fac asta? Nu vă pot da mai multe detalii." },
  ],
  recorder: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/06-arma-noastra-georgian.mp3", seconds: 15.95, line: "Recorder nici nu știe ce-l așteaptă. Vom trimite în luptă arma noastră cea mai bună: Georgian." },
  ],
  nicusor: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/12-nicusordan-face-pe-prostul.mp3", seconds: 7.35, line: "Oare Nicușordan face pe prostul? Pare că se face că nu înțelege." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/08-nicusord-visa-sa-fie-psdist.mp3", seconds: 7.45, line: "Dacă Nicușord a visat toată viața să fie și el PSD-ist?" },
  ],
  georgescu: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/06-calin-georgescu-doua-sute-de-ani.mp3", seconds: 10.55, line: "În călătoriile sale ketaminice se întâlnise cu oamenii lui Călin Georgescu care trăiau două sute de ani." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/14-dati-mi-vaticanul.mp3", seconds: 17.0, line: "Dați-mi Vaticanul. N-am câștigat premiul Nobel, dar pot fi măcar papă." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/15-direct-iisus-tort-vatican.mp3", seconds: 12.65, line: "N-a trecut prin stadiul Napoleon. Direct Iisus. Un tort în forma Vaticanului." },
  ],
  broadcastWin: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/18-winning-too-much.mp3", seconds: 29.45, line: "We're winning too much. We can't take it anymore." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/11-cea-mai-buna-minciuna.mp3", seconds: 9.25, line: "Cea mai bună minciună e adevărul, domnilor. Nu-i adevărat." },
  ],
  radioFiller: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/05-iar-ne-iubeste-psd.mp3", seconds: 7.65, line: "Iar ne iubește PSD. Mare noroc avem cu ei." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/06-relatie-foarte-buna-cu-psd.mp3", seconds: 4.2, line: "Eu am o relație foarte bună cu PSD-ul." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/12-relatie-foarte-buna-cu-psd.mp3", seconds: 20.1, line: "Cel mai mare dușman este PSD... Eu am o relație foarte bună cu PSD-ul." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/08-trump-pariuri-si-tigara.mp3", seconds: 11.35, line: "Trump e fix ca ăla care povestește cât a câștigat la pariuri, apoi cere o țigară." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/11-labradorul-lui-trump.mp3", seconds: 8.55, line: "S-a gudurat pe lângă Trump ca un labrador, iar Trump i-a făcut o Ancuța Alexandrescu." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/09-proiect-de-sapte-miliarde.mp3", seconds: 11.7, line: "Doar dacă treci cu mașina prin Doicești ca PSD-ist se agață de tine două-trei milioane." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/10-blugi-si-banane.mp3", seconds: 13.0, line: "Nouă ne plac blugii și bananele. Blugi și banane și excursii peste hotare." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/13-ce-inseamna-banane-si-blugi.mp3", seconds: 8.89, line: "Ce naiba înseamnă banane și blugi? Îmi bat capul de jumătate de oră." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/05-ambasadorul-sa-stranga-molozul.mp3", seconds: 9.65, line: "Să-l ducem pe ambasadorul Rusiei să strângă molozul și să dea o mână de tencuială." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/03-neinvitat-la-nunta.mp3", seconds: 13.2, line: "Trebuie să fii ca ăla din colțul camerei de care întreabă mirele pe mireasă cine l-a invitat." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/07-hobby-sau-o-iubita.mp3", seconds: 13.1, line: "Să voteze doar cei care i-au dat like. Să-i găsească cineva un hobby sau o iubită." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/09-sa-umble-cu-baietii.mp3", seconds: 8.3, line: "Să fie și el șmecher, să umble cu băieții, să fure, să mintă." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-50/01-suntem-nazisti-gay.mp3", seconds: 4.0, line: "Suntem naziști gay? Da, suntem naziști gay." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/10-eu-sunt-foarte-cald.mp3", seconds: 6.45, line: "Mirabela e mai temperamentală. Eu sunt foarte cald." },
  ],
  /**
   * A kiosk is a tiny radio, so it gets complete, Romanian news/satire beats
   * that make sense as a broadcast heard in public. In particular, these are
   * not sign-offs or contextless medical/dopamine fragments.
   */
  streetKiosk: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/05-iar-ne-iubeste-psd.mp3", seconds: 7.65, line: "Iar ne iubește PSD. Mare noroc avem cu ei." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/06-relatie-foarte-buna-cu-psd.mp3", seconds: 4.2, line: "Eu am o relație foarte bună cu PSD-ul." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/08-nicusord-visa-sa-fie-psdist.mp3", seconds: 7.45, line: "Dacă Nicușord a visat toată viața să fie și el PSD-ist?" },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/09-sa-umble-cu-baietii.mp3", seconds: 8.3, line: "Să fie și el șmecher, să umble cu băieții, să fure, să mintă." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/10-eu-sunt-foarte-cald.mp3", seconds: 6.45, line: "Mirabela e mai temperamentală. Eu sunt foarte cald." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/11-labradorul-lui-trump.mp3", seconds: 8.55, line: "S-a gudurat pe lângă Trump ca un labrador, iar Trump i-a făcut o Ancuța Alexandrescu." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/12-nicusordan-face-pe-prostul.mp3", seconds: 7.35, line: "Oare Nicușordan face pe prostul? Pare că se face că nu înțelege." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/13-ciolacu-fix-asta-faceam.mp3", seconds: 7.25, line: "Se uită Ciolacu și zice: Bă, ești nebun? Fix asta făceam și eu." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/02-au-scapat-usor-galatenii.mp3", seconds: 8.55, line: "Față de privatizări sau mandate de primar PSD, au scăpat foarte ușor gălățenii." },
  ],
  /**
   * A doorway is a shop speaking into the street: adverts and little product
   * beats, rather than a commentator addressing the player personally.
   */
  streetDoorway: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/07-vesnicia-srl.mp3", seconds: 7.9, line: "Nu mai faci față cu plățile? Apelați cu încredere la SC Veșnicia SRL." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/08-mamaliga-si-ceapa.mp3", seconds: 5.35, line: "Tu-ți dai banii, că ți-am dat o sută cincizeci de RON să-ți iei mămăligă și ceapă." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/11-va-plac-bananele-si-blugii.mp3", seconds: 4.5, line: "Dumneavoastră vă plac bananele? Vă plac blugii?" },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-57/13-ce-inseamna-banane-si-blugi.mp3", seconds: 8.89, line: "Ce naiba înseamnă banane și blugi? Îmi bat capul de jumătate de oră." },
  ],
  /**
   * A parked Dacia is the one street source allowed to joke about starting,
   * rattling and paying for fuel. Keeping this pool car-specific makes the
   * visible source label land instead of feeling like a random subtitle.
   */
  streetParkedCar: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/02-nu-ne-lansam-niciunde.mp3", seconds: 3.6, line: "Nu ne lansăm niciunde. Pare că ne vom târî și atât." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/03-romania-legata-cu-sarme.mp3", seconds: 6.4, line: "Toată România de azi e legată cu sârme, bate, troncăne." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/04-cu-caruta-tragem-barca-pe-uscat.mp3", seconds: 8.8, line: "Noi tot cu căruța, cu boi, tragem barca pe uscat." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/10-douazeci-de-ron-motor.mp3", seconds: 6.85, line: "Mie de benzinar mi s-a rupt sufletul. Douăzeci de RON motor." },
  ],
  /** @deprecated Kept for debug callers; street playback uses source pools. */
  streetOverheard: [
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/05-iar-ne-iubeste-psd.mp3", seconds: 7.65, line: "Iar ne iubește PSD. Mare noroc avem cu ei." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-52/06-relatie-foarte-buna-cu-psd.mp3", seconds: 4.2, line: "Eu am o relație foarte bună cu PSD-ul." },
    { file: "audio/vo/ce-ne-enerveaza-new/episode-54/13-ciolacu-fix-asta-faceam.mp3", seconds: 7.25, line: "Se uită Ciolacu și zice: Bă, ești nebun? Fix asta făceam și eu." },
  ],
};

/** Every line in the table, for coverage checks. */
export const ALL_CONTEXT_LINES: VoiceLine[] =
  Object.values(VOICE_CONTEXTS).flat();

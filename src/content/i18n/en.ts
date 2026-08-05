/**
 * ENGLISH — every authored Romanian string, translated.
 *
 * The key is the Romanian sentence exactly as it appears in the table that
 * owns it (see `src/core/i18n.ts` for why). Templates keep their `{name}`
 * placeholders and may reorder them; English word order is not Romanian word
 * order and a translation that cannot move the number is not a translation.
 *
 * WHAT IS DELIBERATELY LEFT ALONE
 *   - Proper nouns: Dacia, București is "Bucharest" but "Piața Victoriei" is
 *     an address, and addresses are not translated. A player looking at a
 *     street sign in the world has to find the same words on the map.
 *   - The four act titles and the studio lockup, which were authored in
 *     English on purpose.
 *   - Anything spoken. The recordings under `public/audio/` are Romanian; the
 *     lines here are subtitles over that speech.
 */

export const EN: Readonly<Record<string, string>> = {
  /* ================================================================== *
   * Boot and loading — src/main.ts, src/ui/menu/frontEnd.ts            *
   * ================================================================== */

  'SE ÎNCARCĂ BUCUREȘTIUL': 'LOADING BUCHAREST',
  'SE ÎNCARCĂ BUCUREȘTIUL…': 'LOADING BUCHAREST…',
  'SE CALIBREAZĂ GRAVITAȚIA': 'CALIBRATING GRAVITY',
  'SE APRINDE APUSUL': 'LIGHTING THE SUNSET',
  'SE CONSTRUIEȘTE BUCUREȘTIUL': 'BUILDING BUCHAREST',
  'SE ÎNCARCĂ CARTIERELE': 'LOADING THE DISTRICTS',
  'SE PORNEȘTE DACIA': 'STARTING THE DACIA',
  'SE UMPLE TRAFICUL': 'FILLING THE TRAFFIC',
  'IES OAMENII ÎN STRADĂ': 'PEOPLE TAKE TO THE STREETS',
  'SE TREZEȘTE BOLOJAN-AGATINEI': 'WAKING BOLOJAN-AGATINEI',
  'MINISTERUL DE-ACCELERĂRII SE MOBILIZEAZĂ': 'THE MINISTRY OF DE-ACCELERATION MOBILISES',
  'SE SCRIE DOSARUL': 'WRITING THE FILE',
  'SE APRINDE INTERFAȚA': 'SWITCHING ON THE INTERFACE',
  'SE DESCHIDE RADIOUL': 'TUNING THE RADIO',
  'SE GRADEAZĂ IMAGINEA': 'GRADING THE IMAGE',
  'GATA — BUCUREȘTI ONLINE': 'READY — BUCHAREST ONLINE',
  'GRAND THEFT AUSTERITY — eroare fatală': 'GRAND THEFT AUSTERITY — fatal error',

  /* ================================================================== *
   * Loading panels and credits — src/ui/menu/panels.ts                 *
   * ================================================================== */

  'SE SIGILEAZĂ CASA BUILDERILOR': 'SEALING THE BUILDERS HOUSE',
  'SE ADUNĂ BUILDERII': 'GATHERING THE BUILDERS',
  'SE CALIBREAZĂ TRANSMISIUNEA': 'CALIBRATING THE BROADCAST',
  'Traversează Bucureștiul, adună builderii, ia stickul cu dovezi de la Recorder și acreditările de emisie de la Nicușor LAN.':
    'Cross Bucharest, gather the builders, take the evidence stick from Recorder and the broadcast credentials from Nicușor LAN.',
  'Ajungi la turnul de emisie și înlocuiești discursul național al lui Georgescu cu ce s-a întâmplat de fapt la Casa Builderilor.':
    'Reach the broadcast tower and replace Georgescu’s national address with what actually happened at the Builders House.',
  'Supraviețuiește întoarcerii, sparge baricada Ministerului și intră pe jos în holul Casei Builderilor. Muzica începe doar după aceea.':
    'Survive the drive back, break the Ministry’s barricade and walk into the Builders House lobby. The music starts only after that.',

  'UN JOC': 'A GAME BY',
  'ÎN ROLURILE PRINCIPALE': 'STARRING',
  'Ilie Bolojan-Agatinei — builderul care nu se oprește':
    'Ilie Bolojan-Agatinei — the builder who never stops',
  'George Georgescu — președintele de pe ecrane':
    'George Georgescu — the president on every screen',
  'Ministerul De-Accelerării Naționale — sistemul':
    'The Ministry of National De-Acceleration — the system',
  'Recorder — curierul de dovezi': 'Recorder — the evidence courier',
  'Nicușor LAN — infrastructura': 'Nicușor LAN — the infrastructure',
  'Ce Ne Enervează — vocea de la radio': 'Ce Ne Enervează — the voice on the radio',
  'Builderii Bucureștiului — mulțimea': 'The Builders of Bucharest — the crowd',
  'ORAȘUL': 'THE CITY',
  'București, generat procedural peste date stradale reale':
    'Bucharest, procedurally generated over real street data',
  'Centrul Vechi · Bulevard · Corporate · Guvern':
    'Old Town · Boulevard · Corporate · Government',
  'Cartier · Industrial · Parc': 'Housing Estates · Industrial · Park',
  'CONSTRUIT CU': 'BUILT WITH',
  'Geometrie în cod. Texturi generate. Shadere inline.':
    'Geometry in code. Generated textures. Inline shaders.',
  'Niciun asset descărcat.': 'Not one downloaded asset.',
  'MUZICĂ': 'MUSIC',
  'MULȚUMIRI': 'THANKS',
  'Tuturor celor care mai construiesc ceva aici.':
    'To everyone still building something here.',
  '„La naiba, iar o luăm de la capăt.”': '“Damn it, here we go again.”',

  'Citite direct din harta de input a jocului, tastă cu tastă, nu dintr-o listă scrisă de mână. Dacă o tastă se schimbă în cod, se schimbă și aici.':
    'Read straight out of the game’s input map, key by key, not from a hand-written list. Change a key in the code and it changes here too.',

  /* ================================================================== *
   * Main menu — src/ui/menu/panels.ts, frontEnd.ts                     *
   * ================================================================== */

  'RELUĂM DE UNDE AM RĂMAS': 'PICK UP WHERE YOU LEFT OFF',
  'TASTE ȘI MOUSE': 'KEYBOARD AND MOUSE',
  'SUNET ȘI IMAGINE': 'SOUND AND VISUALS',
  'CINE A CONSTRUIT ASTA': 'WHO BUILT THIS',
  'LIMBĂ': 'LANGUAGE',
  'ROMÂNĂ SAU ENGLEZĂ': 'ROMANIAN OR ENGLISH',

  'PREZINTĂ': 'PRESENTS',
  'ORICE TASTĂ PENTRU A SĂRI': 'ANY KEY TO SKIP',
  'Se încarcă': 'Loading',
  'Meniu principal': 'Main menu',
  'Progres pornire joc': 'Game start progress',
  'NAVIGARE': 'NAVIGATE',
  'SELECTEAZĂ': 'SELECT',
  'ÎNAPOI': 'BACK',
  'COMENZI': 'CONTROLS',
  'MENIU': 'MENU',
  'MENIU / COMENZI': 'MENU / CONTROLS',
  'MENIU / SETTINGS': 'MENU / SETTINGS',
  'MENIU / CREDITS': 'MENU / CREDITS',
  'MENIU / LIMBĂ': 'MENU / LANGUAGE',
  'ESC ÎNAPOI': 'ESC BACK',
  'TAP ÎNAPOI': 'TAP TO GO BACK',
  'TAP RÂND · {back}': 'TAP A ROW · {back}',
  '↑ ↓ RÂND · ← → MODIFICĂ · ESC ÎNAPOI': '↑ ↓ ROW · ← → ADJUST · ESC BACK',
  '↑ ↓ RÂND · ENTER ALEGE · ESC ÎNAPOI': '↑ ↓ ROW · ENTER CHOOSE · ESC BACK',
  'Comenzile apar după ce jocul termină de încărcat.':
    'The controls appear once the game has finished loading.',
  'Setările apar după ce jocul termină de încărcat.':
    'The settings appear once the game has finished loading.',
  'Volum principal': 'Master volume',
  'Calitate imagine': 'Graphics quality',
  'Sensibilitate mouse': 'Mouse sensitivity',
  'Inversează axa Y': 'Invert Y axis',
  'NU': 'NO',
  'DA': 'YES',
  'Volumul merge în mixerul jocului, calitatea reconstruiește lanțul de post-procesare, iar sensibilitatea și axa Y sunt cele pe care le citește camera. Aceleași setări apar și în meniul de pauză.':
    'Volume feeds the game mixer, quality rebuilds the post-processing chain, and the sensitivity and Y axis are the ones the camera reads. The same settings appear in the pause menu.',
  'Jocul se traduce pe loc — meniul, interfața, misiunile și subtitrările. Vocile și muzica rămân în română, pentru că sunt înregistrări reale.':
    'The game translates on the spot — menu, interface, missions and subtitles. The voices and the music stay Romanian, because they are real recordings.',

  'SE PREGĂTEȘTE DOSARUL': 'PREPARING THE FILE',
  'SE DESCHIDE DOSARUL SALVAT': 'OPENING THE SAVED FILE',
  'SE PREGĂTEȘTE UN DOSAR NOU': 'PREPARING A NEW FILE',
  'SE PORNEȘTE BUCUREȘTIUL': 'STARTING BUCHAREST',
  'SE RESTABILEȘTE POZIȚIA': 'RESTORING YOUR POSITION',
  'SE AȘAZĂ MISIUNEA': 'SETTING UP THE MISSION',
  'ULTIMELE VERIFICĂRI': 'FINAL CHECKS',
  'Clic pentru a prinde mouse-ul': 'Click to capture the mouse',

  /* Quality tiers — src/ui/menu/settings.ts, src/ui/pauseMenu.ts */
  'SCĂZUT': 'LOW',
  'MEDIU': 'MEDIUM',
  'ÎNALT': 'HIGH',

  /* ================================================================== *
   * CONTINUE sub-label — src/ui/menu/session.ts                        *
   * ================================================================== */

  'NICIUN PROGRES SALVAT': 'NO SAVED PROGRESS',
  'SESIUNE SALVATĂ': 'SAVED SESSION',
  'ACTUL {n}': 'ACT {n}',
  'NIVEL {n}': 'LEVEL {n}',
  '{n} MIN': '{n} MIN',
  'ACUM': 'JUST NOW',
  '{n} MIN ÎN URMĂ': '{n} MIN AGO',
  '{n} H ÎN URMĂ': '{n} H AGO',
  '{n} ZILE ÎN URMĂ': '{n} DAYS AGO',

  /* ================================================================== *
   * Keys and controls — src/core/keyHints.ts, src/ui/menu/bindings.ts  *
   * ================================================================== */

  'SPAȚIU': 'SPACE',
  'SHIFT DR.': 'R SHIFT',
  'CTRL DR.': 'R CTRL',
  'ALT DR.': 'R ALT',
  'CLIC ST.': 'LMB',
  'CLIC MIJ.': 'MMB',
  'CLIC DR.': 'RMB',
  'CLIC STÂNGA': 'LEFT CLICK',
  'CLIC MIJLOC': 'MIDDLE CLICK',
  'CLIC DREAPTA': 'RIGHT CLICK',

  'PE JOS': 'ON FOOT',
  'LA VOLAN': 'DRIVING',
  'SISTEM': 'SYSTEM',

  'Mergi': 'Move',
  'Privește în jur': 'Look around',
  'Privește': 'Look',
  'Fugi': 'Sprint',
  'Sari': 'Jump',
  'Ghemuit': 'Crouch',
  'Lovește': 'Punch',
  'Ochește': 'Aim',
  'Trage': 'Fire',
  'Urcă în mașină / interacționează': 'Enter vehicle / interact',
  'Interacționează / urcă în mașină': 'Interact / enter vehicle',
  'Accelerează / frânează': 'Accelerate / brake',
  'Accelerează': 'Accelerate',
  'Frânează / marșarier': 'Brake / reverse',
  'Virează': 'Steer',
  'Frână de mână': 'Handbrake',
  'Claxon': 'Horn',
  'Coboară din mașină': 'Exit vehicle',
  'Postul următor': 'Next station',
  'Privește în spate': 'Look behind',
  'Schimbă camera': 'Switch camera',
  'Hartă': 'Map',
  'Pauză / meniu': 'Pause / menu',
  'Mod foto': 'Photo mode',
  'Înainte': 'Forward',
  'Înapoi': 'Back',
  'Stânga': 'Left',
  'Dreapta': 'Right',

  /* ================================================================== *
   * Pause menu — src/ui/pauseMenu.ts                                   *
   * ================================================================== */

  'PAUZĂ': 'PAUSED',
  'MENIU / SETĂRI': 'MENU / SETTINGS',
  'B★ BUILDERSTAR GAMES — TRANSMISIUNE ÎNTRERUPTĂ':
    'B★ BUILDERSTAR GAMES — BROADCAST INTERRUPTED',
  'ESC ÎNAPOI · ↑ ↓ NAVIGARE · ← → MODIFICĂ · ENTER SELECTEAZĂ':
    'ESC BACK · ↑ ↓ NAVIGATE · ← → ADJUST · ENTER SELECT',
  'REIA JOCUL': 'RESUME',
  'înapoi în București': 'back to Bucharest',
  'SALVEAZĂ': 'SAVE',
  'SETĂRI': 'SETTINGS',
  'imagine, sunet, mouse': 'visuals, sound, mouse',
  'toate tastele': 'every key',
  'progres salvat': 'progress saved',
  'salvarea nu este disponibilă': 'saving is unavailable',
  'scrie progresul în browser': 'writes progress to the browser',
  'nivel {level} · {lei} lei · {mins} min': 'level {level} · {lei} lei · {mins} min',
  'Citite direct din harta de input a jocului — nu dintr-o listă scrisă de mână.':
    'Read straight out of the game’s input map — not from a hand-written list.',

  /* ================================================================== *
   * Walkthrough — src/ui/walkthroughSteps.ts, walkthrough.ts           *
   * ================================================================== */

  'GHID': 'GUIDE',
  'Mișcă mouse-ul ca să te uiți în jur': 'Move the mouse to look around',
  'Clic o dată în fereastră dacă nu se mișcă nimic — jocul are nevoie de mouse.':
    'Click once in the window if nothing moves — the game needs the mouse.',
  'Mergi prin piață': 'Walk across the square',
  'Cele patru taste care te duc oriunde în București.':
    'The four keys that take you anywhere in Bucharest.',
  'Ține SHIFT ca să alergi': 'Hold SHIFT to run',
  'Ministerul nu te așteaptă.': 'The Ministry will not wait for you.',
  'Urmează marcajul auriu și apasă E': 'Follow the gold marker and press E',
  'Diamantele violet sunt tot ce poți atinge: oameni, uși, obiective.':
    'The violet diamonds are everything you can touch: people, doors, objectives.',
  'Găsește o mașină și urcă la volan': 'Find a car and get behind the wheel',
  'Apasă E lângă ea. Dacia galbenă e a ta, restul se împrumută.':
    'Press E next to it. The yellow Dacia is yours; the rest are borrowed.',
  'Condu până la capătul bulevardului': 'Drive to the end of the boulevard',
  'Frâna de mână e pentru colțuri și pentru poliție.':
    'The handbrake is for corners and for the police.',
  'Deschide harta': 'Open the map',
  'Tot orașul, cu obiectivul și activitățile pe el.':
    'The whole city, with your objective and the activities on it.',
  'Restul comenzilor sunt în meniul de pauză': 'The rest of the controls are in the pause menu',
  'Acolo găsești lista completă, setările și salvarea. Succes, builder.':
    'That is where the full list, the settings and the save live. Good luck, builder.',

  /* ================================================================== *
   * HUD — src/ui/hud.ts                                                *
   * ================================================================== */

  'MISIUNE EȘUATĂ': 'MISSION FAILED',
  'Marcajul de reluare te așteaptă.': 'The retry marker is waiting for you.',
  'POVESTEA CONTINUĂ': 'THE STORY CONTINUES',
  'Urmează marcajul auriu și apasă E.': 'Follow the gold marker and press E.',
  'NIV {level}': 'LVL {level}',
  '{score} puncte': '{score} points',

  /* ================================================================== *
   * Contextual prompts — src/gameplay/contextPrompt.ts                 *
   * ================================================================== */

  'mașină': 'car',
  'furgonetă': 'van',
  'camion': 'truck',
  'autobuz': 'bus',
  'mașina poliției': 'police car',
  'tramvai': 'tram',
  'scuter': 'scooter',
  'Urcă în {vehicle}': 'Get into the {vehicle}',

  /* ================================================================== *
   * Places — src/content/places.ts, src/world/city/landmarks.ts        *
   * ================================================================== */

  'Casa Builderilor': 'The Builders House',
  'Serverul comunității': 'The community server',
  'Baricada Ministerului': 'The Ministry barricade',
  'Piața Victoriei': 'Piața Victoriei',
  'Curtea Startup': 'The Startup Courtyard',
  'Piața Transmisiunii': 'Broadcast Square',
  'Parcul Cișmigiu': 'Cișmigiu Park',
  'Palatul Parlamentului': 'The Palace of the Parliament',
  /* Interiors — src/world/interiors/defs.ts */
  'Holul Casei Builderilor': 'The Builders House Lobby',
  'Barul Builderilor': 'The Builders Bar',
  'Redacția Recorder': 'The Recorder Newsroom',
  'Studioul de Transmisiune': 'The Broadcast Studio',
  'Magazin Non-Stop': '24h Corner Shop',
  'Scara Blocului 12': 'Block 12, Stairwell',

  /* ================================================================== *
   * The campaign — src/content/story.ts                                *
   * ================================================================== */

  /* Act I */
  'Ordin de Evacuare': 'Eviction Order',
  'Ministerul sigilează Casa Builderilor.': 'The Ministry is sealing the Builders House.',
  'Vorbește cu builderii': 'Talk to the builders',
  'Ministerul a lipit ordinul pe ușă.': 'The Ministry has taped the order to the door.',
  'Ilie! Au sigilat clădirea. Ordin de evacuare, semnat azi-dimineață.':
    'Ilie! They sealed the building. Eviction order, signed this morning.',
  'La naiba, iar o luăm de la capăt.': 'Damn it, here we go again.',
  'Serverul comunității e încă înăuntru. Dacă îl iau ei, s-a terminat.':
    'The community server is still inside. If they take it, it is over.',
  'Ia serverul comunității': 'Take the community server',
  'Lângă scara de incendiu, în curte.': 'By the fire escape, in the yard.',
  'Un rack, patruzeci de kilograme și toată munca noastră pe el.':
    'One rack, forty kilos, and all our work on it.',
  'Încarcă serverul în Dacia': 'Load the server into the Dacia',
  'Dacia e la bordură, în fața curții.': 'The Dacia is at the kerb, in front of the yard.',
  'Ministerul De-Accelerării Naționale anunță o operațiune de ordine în zona Casa Builderilor.':
    'The Ministry of National De-Acceleration announces a public order operation in the Builders House area.',
  'Ieși din cordonul Ministerului': 'Get out of the Ministry cordon',
  'Trei sute de metri și nu te uita în oglindă.':
    'Three hundred metres, and do not look in the mirror.',
  'Tușește, dar merge. Ca toată țara.': 'It coughs, but it runs. Like the whole country.',

  /* Act II */
  'Traversează orașul. Adună dovezile și acreditările.':
    'Cross the city. Collect the evidence and the credentials.',
  'Pornește rezistența': 'Start the resistance',
  'Ajungi la Piața Victoriei': 'Reach Piața Victoriei',
  'Operativul Recorder te așteaptă la predare.':
    'The Recorder operative is waiting for the handover.',
  'Sunt în piață. Am filmat tot ce au făcut la sigilare. Vino singur.':
    'I am in the square. I filmed everything they did at the sealing. Come alone.',
  'Ia stickul cu dovezi de la Alex Need-Aid': 'Take the evidence stick from Alex Need-Aid',
  'Pe jos. Nu opri motorul lângă el.': 'On foot. Do not cut the engine next to him.',
  'Vorbește cu Alex Need-Aid': 'Talk to Alex Need-Aid',
  'Patru ore de material brut. Semnături, ordine, numele tuturor.':
    'Four hours of raw footage. Signatures, orders, everyone’s names.',
  'Dacă difuzezi asta, nu mai ai unde să te întorci. Știi, da?':
    'If you broadcast this, you have nowhere left to go back to. You know that, right?',
  'Mă întorc exact acolo de unde m-au dat afară.':
    'I am going back to exactly where they threw me out of.',
  'Ajungi la Curtea Startup': 'Reach the Startup Courtyard',
  'Nicușor LAN are ruta și acreditările.': 'Nicușor LAN has the route and the credentials.',
  'Ia acreditările de emisie de la Nicușor LAN':
    'Take the broadcast credentials from Nicușor LAN',
  'Pe jos, în curte.': 'On foot, in the courtyard.',
  'Vorbește cu Nicușor LAN': 'Talk to Nicușor LAN',
  'Fibra intră pe sub piață. Turnul are un singur router și parola e din 2011.':
    'The fibre runs in under the square. The tower has one router and the password is from 2011.',
  'Ți-am scris ruta. Nu intra pe bulevard, au filtru la kilometrul doi.':
    'I wrote you the route. Stay off the boulevard, they have a checkpoint at kilometre two.',
  'Scapă de Minister': 'Shake off the Ministry',
  'Zero stele și te lasă în pace.': 'Zero stars and they leave you alone.',
  'Ai Ministerul în coadă. Rupe contactul și sună-mă când ai zero stele.':
    'The Ministry is on your tail. Break contact and call me at zero stars.',

  /* Act III */
  'Înlocuiește discursul național al lui Georgescu.':
    'Replace Georgescu’s national address.',
  'Pregătește emisia': 'Prepare the broadcast',
  'Ajungi la Piața Transmisiunii': 'Reach Broadcast Square',
  'Discursul intră în direct în opt minute.': 'The address goes live in eight minutes.',
  'Builderii independenți destabilizează națiunea. Statul construiește singur.':
    'Independent builders destabilise the nation. The state builds on its own.',
  'Omul ăsta n-a pus o cărămidă în viața lui.':
    'That man has never laid a brick in his life.',
  'Preia turnul de emisie': 'Take over the broadcast tower',
  'Server + dovezi + acreditări. Pe jos, la bază.':
    'Server + evidence + credentials. On foot, at the base.',
  'Preia emisia națională': 'Take over the national broadcast',
  'Ești pe fibră. Ai treizeci de secunde de tăcere și pe urmă ești tu în direct.':
    'You are on the fibre. Thirty seconds of silence, and then you are live.',
  'Ține emisia patruzeci de secunde': 'Hold the broadcast for forty seconds',
  'Nu părăsi piața.': 'Do not leave the square.',
  'Bună seara. Nu suntem instabilitate. Suntem întreținerea.':
    'Good evening. We are not instability. We are the maintenance.',
  'Toate ecranele orașului au trecut pe altceva. Nimeni nu știe pe ce.':
    'Every screen in the city has switched to something else. Nobody knows what.',

  /* Act IV */
  'Întoarce-te acasă prin tot ce are Ministerul.':
    'Get home through everything the Ministry has.',
  'Pornește întoarcerea': 'Begin the drive back',
  'Întoarce-te la Casa Builderilor': 'Return to the Builders House',
  'Cinci stele. Tot orașul te caută.': 'Five stars. The whole city is looking for you.',
  'Instabilitate politică maximă. Toate unitățile, pe bulevardul central.':
    'Maximum political instability. All units to the central boulevard.',
  'Sparge baricada Ministerului': 'Break the Ministry barricade',
  'Sparge baricada': 'Break the barricade',
  'Bare de oțel și o hârtie A4. Ghici care ține.':
    'Steel bars and one sheet of A4. Guess which one holds.',
  'Intră în Casa Builderilor': 'Enter the Builders House',
  'Pe ușa pietonală. Mașina rămâne afară.':
    'Through the pedestrian door. The car stays outside.',
  'Aceeași ușă. De data asta o deschid eu.':
    'The same door. This time I am the one opening it.',
  'Eliberează Casa Builderilor': 'Liberate the Builders House',
  'La recepție, în hol.': 'At the reception desk, in the lobby.',
  'Aprindeți luminile. Deschideți ușile. Chemați pe toată lumea.':
    'Turn on the lights. Open the doors. Call everyone.',
  'S-a întors! Puneți muzica!': 'He is back! Put the music on!',

  /* Speakers */
  'Builder': 'Builder',
  'Radio': 'Radio',
  'ȘTIRI': 'NEWS',

  /* Level names — src/content/story.ts */
  'Idee': 'Idea',
  'Runway': 'Runway',
  'Tracțiune': 'Traction',
  'Seria A': 'Series A',
  'Scale-up': 'Scale-up',
  'Unicorn': 'Unicorn',
  'IPO': 'IPO',
  'Monopol': 'Monopoly',
  'Fond suveran': 'Sovereign Fund',
  'Legendă': 'Legend',

  /* ================================================================== *
   * Mission runtime — src/gameplay/missions.ts                         *
   * ================================================================== */

  'PROLOG — CASA SUB SIGILIU': 'PROLOGUE — THE HOUSE UNDER SEAL',
  'Georgescu a închis Casa Builderilor. Ministerul confiscă ultimul server. Vorbește cu builderii de la intrare.':
    'Georgescu has closed the Builders House. The Ministry is confiscating the last server. Talk to the builders at the entrance.',
  'Președintele Georgescu a ordonat evacuarea Casei Builderilor. Ministerul a sigilat intrarea în această dimineață.':
    'President Georgescu has ordered the eviction of the Builders House. The Ministry sealed the entrance this morning.',
  'ACTUL {n} — {title}': 'ACT {n} — {title}',
  '{title} — REUȘIT': '{title} — COMPLETE',
  '{title} — EȘUAT': '{title} — FAILED',
  '+{xp} XP · +{lei} lei': '+{xp} XP · +{lei} lei',
  'Mai întâi: {title}': 'First: {title}',
  'Reia: {title}': 'Retry: {title}',
  '{label} — Actul {n}': '{label} — Act {n}',
  'Misiune abandonată': 'Mission abandoned',
  'Obiectiv îndeplinit': 'Objective complete',
  'Serverul comunității: în brațe': 'Community server: in your arms',
  'Stick cu dovezi: preluat': 'Evidence stick: collected',
  'Acreditări de emisie: preluate': 'Broadcast credentials: collected',
  'Baricada e jos': 'The barricade is down',
  'Ești în holul Casei Builderilor': 'You are in the Builders House lobby',
  'Casa Builderilor e din nou deschisă. Muzica e a noastră.':
    'The Builders House is open again. The music is ours.',
  'Builderii sunt acasă.': 'The builders are home.',
  'Muzica e a noastră.': 'The music is ours.',
  'Dacia a sosit': 'The Dacia has arrived',
  'ai murit': 'you died',
  'abandonat': 'abandoned',
  'timp expirat': 'out of time',

  /* ================================================================== *
   * Cinematics — src/gameplay/cameraSystem.ts                          *
   * ================================================================== */

  'ACTUL I — ÎNCHEIAT': 'ACT I — COMPLETE',
  'Serverul e în portbagaj. Casa nu mai e a nimănui.':
    'The server is in the boot. The House belongs to nobody now.',
  'ACTUL II — ÎNCHEIAT': 'ACT II — COMPLETE',
  'Dovezile sunt la tine. Acum trebuie difuzate.':
    'You have the evidence. Now it has to be broadcast.',
  'ACTUL III — ÎNCHEIAT': 'ACT III — COMPLETE',
  'Toată țara v-a auzit.': 'The whole country heard you.',
  'CASA BUILDERILOR': 'THE BUILDERS HOUSE',
  'E din nou deschisă.': 'It is open again.',
  'EMISIE PIRAT': 'PIRATE BROADCAST',
  'Semnalul Ministerului e al nostru.': 'The Ministry’s signal is ours.',
  'REȚINUT': 'DETAINED',
  'EȘUAT': 'FAILED',
  'Magazinul de Suveniruri': 'The Gift Shop',

  /* Photo mode */
  'ARHIVĂ 1989': 'ARCHIVE 1989',
  'NOAPTE ELECTRICĂ': 'ELECTRIC NIGHT',
  'AUSTERITATE': 'AUSTERITY',
  'NEGATIV DE STAT': 'STATE NEGATIVE',
  'ÎNCLINARE': 'ROLL',
  'FOTO': 'PHOTO',
  '<b>WASD</b> mișcare · <b>Space/C</b> sus-jos · <b>Shift</b> rapid · <b>Ctrl</b> lent':
    '<b>WASD</b> move · <b>Space/C</b> up-down · <b>Shift</b> fast · <b>Ctrl</b> slow',
  '<b>,</b> <b>.</b> unghi · <b>[</b> <b>]</b> înclinare · <b>−</b> <b>=</b> focus · <b>;</b> <b>\'</b> blur':
    '<b>,</b> <b>.</b> angle · <b>[</b> <b>]</b> roll · <b>−</b> <b>=</b> focus · <b>;</b> <b>\'</b> blur',
  '<b>F</b> filtru · <b>G</b> grilă · <b>B</b> benzi · <b>H</b> ascunde interfața · <b>0</b> reset · <b>P</b> ieșire':
    '<b>F</b> filter · <b>G</b> grid · <b>B</b> bars · <b>H</b> hide interface · <b>0</b> reset · <b>P</b> exit',

  /* ================================================================== *
   * Side activities — src/content/activities.ts                        *
   * ================================================================== */

  'CURIER': 'COURIER',
  'CURSĂ': 'RACE',
  'EVADARE': 'ESCAPE',
  'BRONZ': 'BRONZE',
  'ARGINT': 'SILVER',
  'AUR': 'GOLD',

  'Curier: server': 'Courier: server',
  'Un rack de 40 kg și două adrese. Nu frâna brusc.':
    'A 40 kg rack and two addresses. Do not brake hard.',
  'Curier: cafea': 'Courier: coffee',
  'Douăsprezece cafele pentru echipa de noapte. Reci nu se plătesc.':
    'Twelve coffees for the night shift. Cold ones do not get paid for.',
  'Curier: dovezi': 'Courier: evidence',
  'Un stick, două redacții și un Minister care ascultă.':
    'One stick, two newsrooms and a Ministry that is listening.',
  'Cursă: Bulevardul Magheru': 'Race: Bulevardul Magheru',
  'Patru viraje, zero scuze.': 'Four corners, zero excuses.',
  'Cursă: Unirii': 'Race: Unirii',
  'Tur complet. Dacia nu iartă bordurile.':
    'A full lap. The Dacia does not forgive kerbs.',
  'Evadare: Centrul Vechi': 'Escape: Old Town',
  'Trei stele, străzi înguste. Pierde-i.': 'Three stars, narrow streets. Lose them.',
  'Evadare: Cartierul guvernamental': 'Escape: The government quarter',
  'Patru stele lângă Palat. Fugi pe unde poți.':
    'Four stars next to the Palace. Run wherever you can.',
  'Recompensă foto: Piața Victoriei': 'Photo bounty: Piața Victoriei',
  'Trei ecrane cu Georgescu. Fă-le poză înainte de patrulă.':
    'Three screens with Georgescu on them. Photograph them before the patrol.',
  'Recompensă foto: Palatul Parlamentului': 'Photo bounty: The Palace of the Parliament',
  'Portretele de pe axa monumentală. Curaj.':
    'The portraits along the monumental axis. Courage.',
  'Recompensă foto: Casa Builderilor': 'Photo bounty: The Builders House',
  'Ecranele de pe fațada propriei tale clădiri.':
    'The screens on the facade of your own building.',

  'Ridică serverul': 'Pick up the server',
  'Ridică tava': 'Pick up the tray',
  'Ridică stickul': 'Pick up the stick',
  'Livrare 1': 'Drop-off 1',
  'Livrare 2': 'Drop-off 2',
  'Redacția 1': 'Newsroom 1',
  'Redacția 2': 'Newsroom 2',
  'Punct 1': 'Checkpoint 1',
  'Punct 2': 'Checkpoint 2',
  'Punct 3': 'Checkpoint 3',
  'Sosire': 'Finish',
  'Ecran 1': 'Screen 1',
  'Ecran 2': 'Screen 2',
  'Ecran 3': 'Screen 3',
  'Ecran fațadă': 'Facade screen',
  'Ecran lateral': 'Side screen',
  'Panou curte': 'Courtyard board',
  'ecranul': 'the screen',
  'Fotografiază {what}': 'Photograph {what}',

  /* ================================================================== *
   * Shops and activity runtime — src/gameplay/activities.ts            *
   * ================================================================== */

  'Covrigărie «La Builderi»': 'Pretzel stand “La Builderi”',
  'Covrig cu susan': 'Sesame pretzel',
  'Shaormerie non-stop «Victoriei»': '24h shawarma “Victoriei”',
  'Shaorma mare cu de toate': 'Large shawarma with everything',
  'Bufetul «Curtea Startup»': 'Canteen “Curtea Startup”',
  'Mici cu muștar': 'Mici with mustard',
  'Gogoșerie Cișmigiu': 'Cișmigiu doughnuts',
  'Gogoși cu vișine': 'Sour cherry doughnuts',
  'Grătarul «La Antenă»': 'The grill “La Antenă”',
  'Mici și o bere fără': 'Mici and one alcohol-free beer',
  'Service Auto «Dacia Frate»': 'Garage “Dacia Frate”',
  'Vopsitorie «Fără Numere»': 'Respray “Fără Numere”',
  'Service Auto «Piese la Negru»': 'Garage “Piese la Negru”',
  'Vopsitorie «Culoare Nouă»': 'Respray “Culoare Nouă”',

  '{name} — reparație': '{name} — repair',
  '{kind} — {name}': '{kind} — {name}',
  'Mai lasă-l puțin să se facă': 'Give it a minute longer',
  'Nu ți-e foame': 'You are not hungry',
  'Nu ai {cost} lei': 'You do not have {cost} lei',
  '{item} · −{cost} lei · +{gained} viață': '{item} · −{cost} lei · +{gained} health',
  'Mașina n-are nimic. Deocamdată.': 'The car is fine. For now.',
  'Reparația costă {cost} lei. Nu-i ai.': 'The repair costs {cost} lei. You do not have it.',
  '{name}: ca nouă · −{cost} lei': '{name}: good as new · −{cost} lei',
  'Vopsitoria cere {cost} lei înainte': 'The respray wants {cost} lei up front',
  'Culoare nouă, numere noi · −{cost} lei · {before} → {after} ★':
    'New colour, new plates · −{cost} lei · {before} → {after} ★',
  'Culoare nouă · −{cost} lei. Nimeni nu te căuta oricum.':
    'New colour · −{cost} lei. Nobody was looking for you anyway.',
  'Termină provocarea curentă întâi': 'Finish the current challenge first',
  'Nu în timpul unei misiuni': 'Not during a mission',
  'Ai nevoie de o mașină': 'You need a car',
  '{name} — {medal}': '{name} — {medal}',
  '{score} puncte · +{lei} lei': '{score} points · +{lei} lei',
  '{score} puncte · +{lei} lei · record nou': '{score} points · +{lei} lei · new record',
  '{name}: {score} ({medal})': '{name}: {score} ({medal})',
  '{name}: eșuat': '{name}: failed',

  /* ================================================================== *
   * Progression — src/gameplay/progression.ts                          *
   * ================================================================== */

  'Alergi cu 15% mai repede': 'You run 15% faster',
  'Dacia la comandă · evadare de patru stele': 'Dacia on call · four-star escape',
  'Instabilitatea scade mai repede · cursa Unirii':
    'Instability cools faster · the Unirii race',
  'Recompensele activităților +50%': 'Activity rewards +50%',
  'Încasezi cu 20% mai puțin': 'You take 20% less damage',
  'Ai cunoștințe: șpaga și amenzile −30%':
    'You know people: bribes and fines −30%',
  'conținut nou': 'new content',
  'NIVEL {level} — {name}: {text}': 'LEVEL {level} — {name}: {text}',
  'Ai scăpat de Minister · +{gain} XP': 'You shook off the Ministry · +{gain} XP',

  /* ================================================================== *
   * Wanted, arrest and bribes — src/gameplay/wanted.ts                 *
   * ================================================================== */

  'Depozitul Ministerului · Piața Victoriei': 'Ministry depot · Piața Victoriei',
  'Blocul de rețineri · Palatul Parlamentului':
    'Detention block · The Palace of the Parliament',
  'Te încolțesc — FUGI': 'They are closing in — RUN',
  'Te blochează — nu opri': 'They are blocking you in — do not stop',
  'REȚINERE': 'ARREST',
  'MINISTERUL DE-ACCELERĂRII NAȚIONALE': 'MINISTRY OF NATIONAL DE-ACCELERATION',
  'Instabilitate politică': 'Political instability',
  'Amendă administrativă': 'Administrative fine',
  'Vehicul': 'Vehicle',
  'rămâne unde l-ai lăsat': 'stays where you left it',
  'Ore de „lămuriri”': 'Hours of “clarifications”',
  'Eliberare': 'Release',
  'Plătește amenda · {fine} lei': 'Pay the fine · {fine} lei',
  'Refuză · {hours} ore': 'Refuse · {hours} hours',
  'Decizi în {left}s. Dacă nu decizi, plătesc ei din buzunarul tău.':
    'You decide in {left}s. If you do not, they help themselves to your pocket.',
  'Nu ai {fine} lei. Decizi în {left}s.': 'You do not have {fine} lei. You decide in {left}s.',
  'Plătit {paid} lei. Ești liber. Găsește-ți mașina.':
    'Paid {paid} lei. You are free. Go find your car.',
  'Reținut {hours} ore. Taxă de dosar: {paid} lei.':
    'Held for {hours} hours. Filing fee: {paid} lei.',
  'Nu ai atât. Rămâi.': 'You do not have that much. You are staying.',
  'Eliberat · −{paid} lei · {hours} ore pierdute':
    'Released · −{paid} lei · {hours} hours gone',
  'Eliberat după {hours} ore · {where}': 'Released after {hours} hours · {where}',
  'Nu chiar acum. Se uită lumea.': 'Not right now. People are watching.',
  'Îți cere {cost} lei. Nu-i ai.': 'He wants {cost} lei. You do not have it.',
  'A luat banii și a raportat. −{cost} lei, +1 ★':
    'He took the money and called it in. −{cost} lei, +1 ★',
  '„Pentru dosar.” −{cost} lei · {before} → {after} ★':
    '“For the file.” −{cost} lei · {before} → {after} ★',
  'Dă șpagă inspectorului — {cost} lei': 'Bribe the inspector — {cost} lei',

  /* ================================================================== *
   * Player and save — src/gameplay/player.ts, src/core/save.ts         *
   * ================================================================== */

  'Mașina e praf · tractare și daune −{paid} lei':
    'The car is wrecked · towing and damages −{paid} lei',
  'Mașina e praf · ai plătit {paid} din {fee} lei. Restul ți-l reține Ministerul.':
    'The car is wrecked · you paid {paid} of {fee} lei. The Ministry keeps the rest.',
  'Salvarea s-a încărcat parțial ({failed})': 'The save loaded only partly ({failed})',

  /* ================================================================== *
   * Map — src/ui/map/*                                                 *
   * ================================================================== */

  'BUCUREȘTI': 'BUCHAREST',
  'CENTRUL VECHI': 'OLD TOWN',
  'BULEVARDE': 'BOULEVARDS',
  'SECTORUL DE STICLĂ': 'THE GLASS SECTOR',
  'CARTIERUL GUVERNAMENTAL': 'THE GOVERNMENT QUARTER',
  'CARTIERE DE BLOCURI': 'HOUSING ESTATES',
  'ZONA INDUSTRIALĂ': 'THE INDUSTRIAL ZONE',
  'PARC': 'PARK',
  /* Full-map chrome — note the double spaces before the key glyphs. */
  'B★ BULETIN CARTOGRAFIC — SECTORUL 0': 'B★ CARTOGRAPHIC BULLETIN — SECTOR 0',
  'HARTA BUCUREȘTIULUI': 'MAP OF BUCHAREST',
  'CLIC <b>MARCAJ</b> · ROTIȚĂ <b>ZOOM</b> · TRAGE <b>MUTĂ</b>':
    'CLICK <b>MARKER</b> · WHEEL <b>ZOOM</b> · DRAG <b>PAN</b>',
  'MĂREȘTE  +': 'ZOOM IN  +',
  'MICȘOREAZĂ  −': 'ZOOM OUT  −',
  'CENTREAZĂ': 'RECENTRE',
  'ȘTERGE MARCAJUL': 'CLEAR MARKER',
  'ÎNCHIDE  M': 'CLOSE  M',
  'M / ESC ÎNCHIDE · N ROTIRE MINIMAPĂ · SĂGEȚI MUTĂ · SPAȚIU CENTREAZĂ':
    'M / ESC CLOSE · N ROTATE MINIMAP · ARROWS PAN · SPACE RECENTRE',
  'MINIMAPĂ ⇧ NORD': 'MINIMAP ⇧ NORTH',
  'MINIMAPĂ ⇧ DIRECȚIE': 'MINIMAP ⇧ HEADING',
  'Fără misiune activă': 'No active mission',
  'MARCAJ {dist}': 'MARKER {dist}',
  ' (linie directă)': ' (direct line)',
  'Marcaj pe hartă': 'Marker placed on the map',
  '{dist} de tine': '{dist} from you',
  'Clic pentru marcaj · clic dreapta pentru anulare':
    'Click to set a marker · right-click to clear it',

  /* Map legend — src/ui/map/fullMap.ts */
  'Tu': 'You',
  'Misiune': 'Mission',
  'Marcaj': 'Marker',
  'Minister': 'Ministry',
  'Curier': 'Courier',
  'Cursă': 'Race',
  'Evadare': 'Escape',
  'Foto': 'Photo',
};

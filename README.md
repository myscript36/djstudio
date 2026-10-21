# DJ Studio 2.0 – Android

Érintőképernyős DJ alkalmazás telefonra és tabletre: 4 deck, jog wheel, SYNC, hot cue, loop,
19 Beat FX, 6 Color FX, Master Tempo, beatgrid szerkesztő, SoundCloud-keresés, saját zenék,
felvétel és Pioneer DDJ-1000 támogatás (USB-OTG kábellel).

## APK készítése GitHubon (nem kell semmit telepíteni)

1. Regisztrálj ingyen a https://github.com oldalon, és jelentkezz be.
2. Jobb fent **+ → New repository** → név: `djstudio` → **Create repository**.
3. A megjelenő oldalon kattints az **uploading an existing file** linkre.
4. Csomagold ki a ZIP-et, és húzd be a böngészőbe **a mappa teljes tartalmát**
   (`app`, `.github`, `build.gradle`, `settings.gradle` … mindent). → **Commit changes**.
   - Ha a `.github` mappa nem látszik (rejtett), lásd lent az „Ha nincs Actions” részt.
5. Kattints fent az **Actions** fülre. A „DJ Studio APK” már fut (kb. 4–6 perc).
6. Ha zöld pipa lett, kattints rá, és lent az **Artifacts** résznél töltsd le a
   **DJStudio-2.0-APK** fájlt. Ebben van a `DJStudio-2.0.apk`.

**Ha nincs Actions:** Actions fül → **set up a workflow yourself** → másold be a
`.github/workflows/build.yml` tartalmát → **Commit changes**.

## Telepítés a telefonra

1. Másold az APK-t a telefonra (vagy töltsd le közvetlenül a telefonon).
2. Nyisd meg → engedélyezd az **Ismeretlen forrásból származó alkalmazások** telepítését.
3. Telepítés → megnyitás. A Play Protect figyelmeztethet (nem a Play Áruházból jön) → „Telepítés mindenképp”.

## Android Studióval

File → Open → ez a mappa → Build → Build APK(s).

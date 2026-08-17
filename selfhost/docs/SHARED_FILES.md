# Sdílené soubory — proč se hlídají zrcadlenými otisky

Třináct souborů v tomhle companionu je **záměrně duplikovaných** v repu appky
(`trpaslik444/construct-cloud-sync`, privátní) a musí zůstat **identických**:
`selfhost/firestore.rules`, `selfhost/storage.rules`,
`selfhost/scripts/openbuildos-storage-setup.mjs` a šest dvojic Cloud Functions
(`membershipClaims`, `planPromotion`, `trashSweep`, `shareLinkRotation`,
`thumbnails` — vždy modul i jeho test).

Seznam vede **Háček 1** v `docs/REPO_BOUNDARIES.md` v hlavním repu. Ten je zdroj
pravdy; `selfhost/shared-files.manifest.json` je jeho **zrcadlo**.

## Proč na tom záleží

Rozdíl ve sdíleném souboru **se neprojeví v UI ani na jedné straně**. Obě
aplikace fungují — jen jedna vymáhá něco, co druhá ne.

15. 8. 2026 byl `selfhost/firestore.rules` 495 řádků pozadu a chybělo mu celé
zmrazení stavby po dobu předání (`projectFrozen`). U self-hostované firmy by se
během předání **tiše ztrácela data**: zápis, který přistane v původním místě po
tom, co se obsah zkopíroval, se do kopie nedostane a po překlopení `workspaceId`
zmizí. Nenašla to kontrola, našla to náhoda při bezpečnostní revizi.

## Past: privátní hlavní repo × veřejný companion

Companion CI se na obsah hlavního repa **nedostane**. Zvažovaly se tři cesty:

| Varianta | Proč ne / proč ano |
| --- | --- |
| **Token do tajemství companionu** a stahovat hlavní repo přímo | ❌ Token s přístupem do privátního repa uložený ve veřejném repu je horší vada než ta, kterou by hlídal. A nefunguje tam, kde je nejvíc potřeba: **PR z forku tajemství nedostane**, takže u cizích příspěvků by kontrola mlčky neběžela. |
| **`repository_dispatch` do hlavního repa** | ❌ Přesouvá problém, neřeší ho — odeslat dispatch do privátního repa taky chce token uložený **tady**. Navíc přijde výsledek asynchronně a PR by nic neblokoval. |
| **Zrcadlené otisky v manifestu** | ✅ Zvoleno. Žádné tajemství, žádná síť, běží i na PR z forku. |

## ⏳ Až bude companion privátní

V plánu je companion překlopit na **privátní** — jeho veřejnost přestala být
aktuální. Tahle tabulka tím dostává datum expirace, takže co platí kdy:

**Nemění se nic na téhle zarážce.** `shared-files-check.mjs` porovnává proti
manifestu v repu, ne přes síť. Nepředpokládá o viditelnosti companionu nic a
běží stejně privátně jako veřejně.

**Mění se důvod, proč tu manifest je.** Obě námitky proti tokenu (tajemství ve
veřejném repu; PR z forku tajemství nedostane) padají naráz — privátní repo
cizí forky nedostává a obě repa má **stejného vlastníka**, který je i jediný,
kdo nasazuje. Token pak není ústupek, ale nejkratší cesta.

**Cílový stav po překlopení:** read-only PAT do tajemství companionu, porovnávat
**přímo** proti hlavnímu repu (`raw.githubusercontent.com` autorizaci hlavičkou
`Bearer` přijímá) a manifest **zrušit**. Ušetří to přepočítávání otisků i celý
`shared-files-sync.mjs`. Do té doby je manifest jediná varianta, která funguje
bez tajemství ve veřejném repu.

**Co se rozbije v den překlopení, když se nic neudělá:** zarážka v hlavním repu
(`scripts/ci/shared-files-parity.mjs`) čte companion **bez tokenu**. Ta to pozná
a řekne „companion nejde přečíst", ne „soubory chybí" — nápravou je doplnit
`GH_TOKEN`, ne kontrolu vypnout.

## Co je červená a co jen varování

Pořadí práce z `REPO_BOUNDARIES.md` je **„uprav companion → slouč ho → zrcadli
do hlavního repa"**. Companion se tedy mění první a v okamžiku svého PR je
hlavní repo **pozadu ze zásady**. Tvrdá kontrola „musí se rovnat hlavnímu repu"
by proto svítila červeně na **každé poctivé změně** — a takovou zarážku někdo do
týdne vypne. Dělí se proto podle toho, **kdo to může spravit v tomhle PR**:

**Červená** — způsobil to tenhle PR a tenhle PR to umí spravit:
- manifest chybí, nejde přečíst, nebo je prázdný (prázdný seznam se **nebere**
  jako „nic ke kontrole" — zarážka, která nic nehlídá, je horší než žádná),
- sdílený soubor v companionu **chybí** (smazaný/přejmenovaný bez zápisu),
- PR mění sdílený soubor a **nepřiznává zrcadlení**.

**Varování** — pravda, ale tenhle PR za to nemůže:
- sdílený soubor se od otisku liší a PR na něj nesáhl → dluh na zrcadlení
  z dřívějška. Shodit kvůli němu cizí PR by znamenalo zablokovat repo, dokud to
  někdo nezrcadlí. Blokující autoritou pro tenhle směr zůstává job
  `shared-files` v CI hlavního repa, který porovnává bajt po bajtu.

## Když měníš sdílený soubor

1. Uprav ho **tady** (companion je kanonický — firmy z něj deployují).
2. Do těla PR dopiš řádek s protějškem:
   ```
   Mirror-to-main: trpaslik444/construct-cloud-sync#<číslo PR>
   ```
   Není to zaškrtávátko: pojmenuje konkrétní PR, který si člověk umí otevřít.
   Že se zrcadlení **opravdu** stalo, ověří bajt po bajtu CI hlavního repa.
3. Po sloučení zrcadli do hlavního repa a tam přepočítej otisky:
   ```
   npm run shared-files:sync
   ```
   (Čte `origin/main` klonu hlavního repa — proto ho pustí jen ten, kdo ho má
   na disku. Seznam se **neopisuje ručně**; skript parsuje Háček 1.)

## Lokálně

```
cd selfhost
npm run shared-files                     # otisky vs. pracovní strom
npm run shared-files -- --base origin/main   # + co mění rozdělaná větev
npm run shared-files:sync -- --check     # neodešel se manifest od Háčku 1?
```

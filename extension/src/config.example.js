// MODÈLE de configuration intégrée. NE PAS remplir ici.
//
// - Soit tu laisses faire setup.js (il crée extension/src/config.js avec tes
//   secrets et l'URL de ton serveur Tailscale).
// - Soit tu configures tout à la main dans la page Options de l'extension.
//
// L'extension fonctionne SANS config.js : dans ce cas, configure via Options.
var GR_BAKED = {
  serverUrl: "",    // vide = aucun envoi, tout reste en local
  passphrase: "",
  serverKey: "",
  deviceTag: "",
  watchedLinks: [], // ex: ["ma-banque.fr", "mon-autre-site.fr"]
};

if (typeof self !== "undefined") self.GR_BAKED = GR_BAKED;

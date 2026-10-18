// Configuration INTÉGRÉE à l'extension.
//
// Ce fichier est (ré)écrit automatiquement par `node setup.js` sur TON PC.
// Après l'avoir lancé, il contient l'URL Tailscale de ton serveur, la phrase
// secrète et le jeton Bearer — si bien qu'il suffit de charger l'extension
// pour que tout fonctionne, sans rien configurer à la main.
//
// Valeurs vides par défaut = l'extension ne fait rien tant que setup.js n'a pas
// été exécuté (ou tant que tu n'as rien saisi dans les Options).
var GR_BAKED = {
  serverUrl: "",   // ex: http://mon-pc.ton-tailnet.ts.net:8787/collect
  passphrase: "",  // identique à celle du serveur
  serverKey: "",   // jeton Bearer, identique à celui du serveur
  deviceTag: "",   // nom de cet appareil
  watchedLinks: [], // sites à protéger (optionnel)
};

if (typeof self !== "undefined") self.GR_BAKED = GR_BAKED;

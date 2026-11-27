# Order

Application de partage de Wi-Fi à Bamako : on partage un Wi-Fi avec l'accord de son propriétaire, on dépense des points pour débloquer ceux des autres, et on peut acheter des points avec Wave ou Orange Money.

## Lancer en local
1. Node 22.13 ou plus récent.
2. `npm i`
3. `cp .env.example .env` puis remplis `SECRET` et `DATA_KEY` (phrases longues et aléatoires, à ne jamais changer ensuite pour DATA_KEY).
4. `npm start` puis ouvre http://localhost:3000
Sans clés SMS, le code de connexion s'affiche dans la console du serveur.

## Mise en ligne
- Héberge le serveur sur un service Node avec HTTPS et un disque persistant (Render, Railway, Fly.io ou un VPS). La base `data.db` doit être sur ce disque et sauvegardée.
- Mets `BASE_URL` à ton adresse publique (https://...). Wave et Orange Money y renvoient le client après le paiement.
- Ajoute les clés dans les variables d'environnement, jamais dans le code.
- Sur téléphone, « Ajouter à l'écran d'accueil » installe Order comme une application.

## Clés à obtenir
- Wave : portail Wave Business > Développeur > clé API (Checkout).
- Orange Money : compte marchand Orange Money Mali, puis identifiants Orange Developer (Web Payment). Vérifie les adresses d'API dans leur documentation.
- SMS : API SMS d'Orange Developer (`SMS_CLIENT_AUTH`, `SMS_SENDER`).

## Avant l'ouverture au public
- Conditions d'utilisation, politique de confidentialité et règles de partage des Wi-Fi (autorisation du propriétaire).
- Fournisseur de cartes payant si le trafic augmente (OpenStreetMap gratuit = usage léger).
- Sauvegardes de la base et suivi des erreurs.

## Détection des Wi-Fi (application Android)
Un navigateur ne peut pas voir les Wi-Fi autour de lui. Seule une application Android installée le peut.
L'application Android doit exposer `window.OrderNative.scanWifi()` qui renvoie `[{ssid, bssid, level}]`.
Order envoie cette liste à `/api/scan` et sépare les Wi-Fi « Enregistrés » et « Non enregistrés ». iPhone : impossible.

## Points
3 points par Wi-Fi ajouté, plafonnés à 15 points par jour. Au-delà, on peut ajouter des Wi-Fi sans points.

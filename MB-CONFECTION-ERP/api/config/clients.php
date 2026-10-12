<?php

// Listes de valeurs du module Clients : alignées sur web/src/lib/clients/options.ts et sur les CHECK de 0004_clients.sql.
return [
    'countries' => [
        'TN', 'FR', 'DE', 'BE', 'NL', 'LU', 'IT', 'ES', 'PT', 'GB', 'IE', 'CH', 'AT', 'SE', 'DK', 'NO', 'FI', 'IS',
        'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'HR', 'SI', 'EE', 'LV', 'LT', 'MT', 'CY',
        'MA', 'DZ', 'LY', 'EG', 'TR', 'AE', 'SA', 'QA', 'US', 'CA', 'CN', 'JP',
    ],
    'currencies' => ['EUR', 'TND', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'MAD'],
    'languages' => ['fr', 'en', 'de', 'es', 'it', 'nl'],
    'payment_methods' => ['transfer', 'cheque', 'lc', 'cash', 'other'],
    'incoterms' => ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'],
];

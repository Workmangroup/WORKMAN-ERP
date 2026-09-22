<?php
declare(strict_types=1);

route('GET', '/notifications', function () {
    $uid = current_user()['id'];
    $rows = q(
        'SELECT id, type, titre, message, lien, lu, date_creation FROM notifications
         WHERE user_id = ? ORDER BY date_creation DESC, id DESC LIMIT 30',
        [$uid],
    );
    $nonLues = (int) q1('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND lu = 0', [$uid])['n'];
    json_out([
        'data' => array_map(fn ($n) => ['lu' => (bool) $n['lu']] + $n, $rows),
        'non_lues' => $nonLues,
    ]);
});

route('PATCH', '/notifications/tout-lu', function () {
    run('UPDATE notifications SET lu = 1 WHERE user_id = ? AND lu = 0', [current_user()['id']]);
    no_content();
});

route('PATCH', '/notifications/{id}/lu', function (array $p) {
    // La condition user_id empêche de marquer les notifications d'un autre
    run('UPDATE notifications SET lu = 1 WHERE id = ? AND user_id = ?', [(int) $p['id'], current_user()['id']]);
    no_content();
});

<?php

use App\Http\Controllers\Api\V1\AddressController;
use App\Http\Controllers\Api\V1\ClientController;
use App\Http\Controllers\Api\V1\ContactController;
use App\Http\Controllers\Api\V1\DirectoryController;
use App\Http\Controllers\Api\V1\EventController;
use App\Http\Controllers\Api\V1\NotificationController;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function () {
    // Vérification de vie : l'API répond et la base PostgreSQL est joignable.
    Route::get('/health', function () {
        try {
            DB::connection()->getPdo();
            $database = 'up';
        } catch (\Throwable $e) {
            $database = 'down';
        }

        return response()->json([
            'status' => $database === 'up' ? 'ok' : 'degraded',
            'database' => $database,
            'version' => 'v1',
        ], $database === 'up' ? 200 : 503);
    });

    Route::middleware('supabase')->group(function () {
        Route::get('/clients', [ClientController::class, 'index']);
        Route::post('/clients', [ClientController::class, 'store']);
        Route::get('/clients/{id}', [ClientController::class, 'show']);
        Route::patch('/clients/{id}', [ClientController::class, 'update']);
        Route::delete('/clients/{id}', [ClientController::class, 'destroy']);
        Route::post('/clients/{id}/archive', [ClientController::class, 'archive']);
        Route::post('/clients/{id}/restore', [ClientController::class, 'restore']);

        Route::get('/clients/{client}/contacts', [ContactController::class, 'index']);
        Route::post('/clients/{client}/contacts', [ContactController::class, 'store']);
        Route::patch('/contacts/{id}', [ContactController::class, 'update']);
        Route::delete('/contacts/{id}', [ContactController::class, 'destroy']);

        Route::get('/clients/{client}/addresses', [AddressController::class, 'index']);
        Route::post('/clients/{client}/addresses', [AddressController::class, 'store']);
        Route::patch('/addresses/{id}', [AddressController::class, 'update']);
        Route::delete('/addresses/{id}', [AddressController::class, 'destroy']);

        Route::get('/payment-terms', [DirectoryController::class, 'paymentTerms']);
        Route::get('/sales-reps', [DirectoryController::class, 'salesReps']);
        Route::get('/users/directory', [DirectoryController::class, 'users']);

        Route::get('/notifications', [NotificationController::class, 'index']);
        Route::post('/notifications/{id}/read', [NotificationController::class, 'markRead']);

        Route::get('/events/failures', [EventController::class, 'failures']);
        Route::post('/events/dispatch', [EventController::class, 'dispatch']);
        Route::post('/events/{id}/replay', [EventController::class, 'replay']);
    });
});

# Image de l'API WORKMAN ERP 360 (Laravel 12, API uniquement).
FROM php:8.4-cli

RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq-dev unzip git \
 && docker-php-ext-install pdo_pgsql \
 && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-scripts --no-interaction --prefer-dist --optimize-autoloader
COPY . .
RUN composer dump-autoload --optimize --no-scripts

EXPOSE 8000
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]

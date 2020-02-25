-- Up
CREATE TABLE `clients` (
    `id` INTEGER PRIMARY KEY,
    -- Client chosen common name of the last issued certificate
    `name` TEXT NOT NULL
);
CREATE TABLE `clientcerts` (
    `client_id` INTEGER NOT NULL,
    -- PEM encoded certificate
    `data` DATA NOT NULL,
    -- SHA256 fingerprint of the certificate (like aa:bb:cc:...)
    `fingerprint_sha256` TEXT NOT NULL,
    -- Email address associated with the certificate
    -- This will also be included in the certificate
    `email_address` TEXT NOT NULL,
    `valid_from` DATE NOT NULL,
    `valid_to` DATE NOT NULL,
    -- Date the certificate was revoked
    `revoked` DATE
);
CREATE INDEX `clientcerts.fingerprint_sha256` ON `clientcerts` (`fingerprint_sha256`);
CREATE UNIQUE INDEX `clientcerts.data.unique` ON `clientcerts` (`data`);
CREATE UNIQUE INDEX `clientcerts.fingerprint_sha256.unique` ON `clientcerts` (`fingerprint_sha256`);
CREATE TABLE `hostnames` (
    `client_id` INTEGER NOT NULL,
    -- Full hostname including domain
    `hostname` TEXT NOT NULL,
    -- True if the client revoked this hostname
    -- If the hostname is revoked because all the client's certificate have been revoked or have expired this will
    -- still be false
    `revoked` BOOLEAN NOT NULL
);
CREATE INDEX `hostnames.hostname` ON `hostnames` (`hostname`);
CREATE UNIQUE INDEX `hostnames.hostname.unique` ON `hostnames` (`hostname`);

-- Down
DROP TABLE `clients`;
DROP TABLE `clientcerts`;
DROP TABLE `hostnames`;

CREATE USER 'restore_reader'@'%' IDENTIFIED BY 'isolated_restore_reader_1031';
GRANT SELECT ON epay_restore.* TO 'restore_reader'@'%';

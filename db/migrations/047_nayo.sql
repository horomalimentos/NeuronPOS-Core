-- NeuronPOS Delivery ahora se llama Nayo. Solo cambia el texto que ve el
-- usuario en el catalogo de modulos; el codigo sigue siendo 'marketplace'.
UPDATE modules
   SET name = 'Nayo',
       description = 'Tu restaurante aparece en Nayo, la plataforma local de pedidos a domicilio: los clientes cercanos ven tu menú y piden, y los repartidores de la plataforma entregan. Sin mensualidad.'
 WHERE code = 'marketplace';

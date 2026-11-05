# stockkeeper

Stock keeping for a small warehouse: quantities with units, stock levels per
location, order lines and CSV imports.

```python
from stockkeeper import Inventory, parse_qty, parse_qty_range

parse_qty("2.5 kg")            # Quantity(amount=Decimal('2.5'), unit='kg')
parse_qty("12")                # Quantity(amount=Decimal('12'), unit='ea')
parse_qty_range("100g to 1kg") # (0.1 kg, 1 kg)

stock = Inventory()
stock.receive("BEANS-1KG", parse_qty("20 kg"))
stock.take("BEANS-1KG", parse_qty("2500 g"))
```

Command line:

```
python3 -m stockkeeper convert "1.5 kg" --to g
python3 -m stockkeeper report receipts-*.csv
```

Run the tests with `python3 -m unittest discover -s tests`.

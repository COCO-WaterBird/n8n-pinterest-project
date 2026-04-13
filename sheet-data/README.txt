Save the pin list to be published as pins.xlsx and place it in this directory
(mapped to /data in the container via docker-compose).

Header row (same column names as the Google Sheet version):
board_id | title | description | alt | link | image_url

The workflow reads the first worksheet by default. To use a specific sheet,
open the "Extract pin rows" node in n8n and set Options -> Sheet Name.

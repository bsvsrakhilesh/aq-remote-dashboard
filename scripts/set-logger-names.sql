-- Display names and location labels for the deployed logger fleet.
-- Device codes, credentials, sensor settings, and telemetry are not changed.
with desired(device_code, display_name, description) as (
  values
    ('aq_outdoor01', 'Karakoram security desk', 'Karakoram'),
    ('aq_outdoor02', 'Karakoram common room', 'Karakoram'),
    ('aq_outdoor03', 'Kumaon Library', 'Kumaon'),
    ('aq_outdoor04', 'Kumaon security desk', 'Kumaon'),
    ('aq_outdoor05', 'III LT 2 INSIDE', 'III LT 2'),
    ('aq_outdoor06', 'III LT 2 Outside', 'III LT 2'),
    ('aq_indoor01', 'III LT 3 INSIDE near whiteboard', 'III LT 3'),
    ('aq_indoor02', 'III LT 3 INSIDE at the back', 'III LT 3'),
    ('aq_indoor03', 'III LT 3 INSIDE near entrance', 'III LT 3'),
    ('aq_indoor05', 'IV LT 4 inside', 'IV LT 4')
)
update public.devices as device
set display_name = desired.display_name,
    description = desired.description
from desired
where device.device_code = desired.device_code;

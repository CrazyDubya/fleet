"""`python3 -m gui` - the one supported way to start the dashboard host.

Running `python3 -m gui.server` used to load gui/server.py TWICE: once as
`__main__` (the module python executes) and once as `gui.server` (imported by
every widget's `from gui.server import HttpError`). Two module objects mean two
distinct `HttpError` classes, so `Handler._widget_route`'s `except HttpError`
(the `__main__` copy's) never caught the one a widget raised - every widget
400/403/404 surfaced as a 500 "error: forbidden". Entering through this file
keeps a single `gui.server` identity: nothing here is imported by anything.
"""
from gui.server import main

main()

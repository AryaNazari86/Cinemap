from django.urls import path

from . import views

app_name = "galaxy"

urlpatterns = [
    path("", views.index, name="index"),
    path("api/art/", views.artwork, name="art"),
    path("api/compare/", views.compare, name="compare"),
]

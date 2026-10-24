FROM mcr.microsoft.com/dotnet/sdk:10.0.103-noble@sha256:e362a8dbcd691522456da26a5198b8f3ca1d7641c95624fadc5e3e82678bd08a AS build
WORKDIR /src
COPY backend-dotnet/DotNetBackend.csproj ./
RUN dotnet restore DotNetBackend.csproj
COPY proto/demo.proto ./proto/demo.proto
COPY backend-dotnet/Program.cs ./
RUN dotnet publish DotNetBackend.csproj -c Release -o /out --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0.3-alpine3.23@sha256:258b939d6d684ff05ad7ea16782b4bee55260de4acc6f99bec897fd11de7640c
WORKDIR /app
COPY --from=build /out ./
ENV ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_EnableDiagnostics=0 \
    Logging__LogLevel__Default=Warning
USER 65532:65532
EXPOSE 50051
HEALTHCHECK --interval=10s --timeout=3s CMD ["dotnet", "/app/DotNetBackend.dll", "--healthcheck"]
ENTRYPOINT ["dotnet", "/app/DotNetBackend.dll"]
